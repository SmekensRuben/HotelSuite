import { before, beforeEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initializeTestEnvironment, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc } from "firebase/firestore";

// These tests exercise real transaction retries, and must only use local emulators.
const projectId = "demo-hotel-suite-a00";
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Local Auth and Firestore emulators are required.");
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, storageBucket: `${projectId}.appspot.com` });
const require = createRequire(import.meta.url);
const { admin } = require("../../functions/src/config");
const { SAAS_RULES_VERSION } = require("../../functions/src/saasRollout");
const { createHotelStockCountHandler, mutateHotelStockCountHandler } = require("../../functions/src/stockCounts");
const { mutateShoppingCartHandler } = require("../../functions/src/shoppingCarts");
const { createOrdersFromCartHandler } = require("../../functions/src/orders");
const db = admin.firestore(), auth = admin.auth();
const services = { firestore: db, auth, now: () => Date.parse("2026-10-16T12:00:00Z") };
const staffA = { uid: "collaboration-a", token: { email_verified: true } };
const staffB = { uid: "collaboration-b", token: { email_verified: true } };
const outsider = { uid: "collaboration-other-hotel", token: { email_verified: true } };
const permissions = ["stockcounts.read", "stockcounts.create", "stockcounts.update", "orders.read", "orders.create"];
const request = (actor, data) => ({ auth: actor, data });
let environment, sequence = 0;
const next = () => `collaboration-${++sequence}`;
const hotelPath = "hotels/hotel-a";
const countPath = (countId) => `${hotelPath}/stockCounts/${countId}`;
const countedItems = (quantity) => [{ catalogProductId: "juice", quantity, unitCost: 2, isCounted: quantity !== null }];
const rejected = (promise, code) => assert.rejects(promise, (error) => error.code === code);
const readCart = async (cartId) => (await db.doc(`${hotelPath}/shoppingCarts/${cartId}`).get()).data();
const mutateCart = (actor, data) => mutateShoppingCartHandler(request(actor, { hotelUid: "hotel-a", requestId: next(), ...data }), services);
const createCount = async () => createHotelStockCountHandler(request(staffA, {
  hotelUid: "hotel-a", type: "Weekly", businessDate: "2026-10-16", requestId: next(),
  locations: ["bar-store", "kitchen-store"].map((locationId) => ({ locationId, stockTemplateId: "weekly" })),
}), services);
const locationInput = (countId, locationId, quantity, expectedLocationRevision = 0, action = "save-location") => ({
  hotelUid: "hotel-a", stockCountId: countId, locationId, action, expectedLocationRevision, requestId: next(), countedItems: countedItems(quantity),
});
const saveLocation = (actor, data) => mutateHotelStockCountHandler(request(actor, data), services);
const lineInput = (cartId, line, action, value) => ({
  cartId, action, productId: line.supplierProductId, purchaseOptionId: line.purchaseOptionId ?? "default",
  lineId: line.lineId, expectedLineRevision: line.lineRevision, ...(value === undefined ? {} : { value }),
});
async function newCart(quantity = 5) {
  const initial = await mutateCart(staffA, { action: "get-or-create" });
  await mutateCart(staffA, { cartId: initial.cartId, action: "add", productId: "juice-case", purchaseOptionId: "default",
    outletId: "bar", value: quantity, expectedRevision: initial.revision });
  return { cartId: initial.cartId, ...await readCart(initial.cartId) };
}
const submission = (cartId, revision) => ({ hotelUid: "hotel-a", shoppingCartId: cartId, expectedCartRevision: revision,
  deliveryDate: "2026-10-19", requestId: next() });
const submit = (actor, input) => createOrdersFromCartHandler(request(actor, input), services);

before(async () => {
  environment = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile("firebase/firestore.rules", "utf8") } });
});
beforeEach(async () => {
  await environment.clearFirestore();
  const users = await auth.listUsers();
  if (users.users.length) await auth.deleteUsers(users.users.map((user) => user.uid));
  for (const actor of [staffA, staffB, outsider]) await auth.createUser({ uid: actor.uid, email: `${actor.uid}@example.test`, emailVerified: true });
  await db.doc("platformConfiguration/saasProcurement").set({ enabled: true, rulesVersion: SAAS_RULES_VERSION });
  for (const hotel of ["hotel-a", "hotel-b"]) {
    await db.doc(`hotels/${hotel}`).set({ name: hotel, currency: "EUR", timeZone: "Europe/Brussels" });
    await db.doc(`hotels/${hotel}/settings/bootstrap`).set({ currency: "EUR" });
    await db.doc(`hotelSubscriptions/${hotel}`).set({ status: "active", validUntil: null, modules: ["procurement"], modulePolicyVersion: 1 });
    await db.doc(`hotels/${hotel}/catalogproducts/juice`).set({ name: "Orange juice", baseUnit: "l", active: true, inventoryTracked: true });
    for (const outlet of ["bar", "kitchen"]) {
      await db.doc(`hotels/${hotel}/outlets/${outlet}`).set({ name: outlet === "bar" ? "Bar" : "Kitchen" });
      await db.doc(`hotels/${hotel}/locations/${outlet}-store`).set({ name: `${outlet} store`, outletId: outlet });
      await db.doc(`hotels/${hotel}/locations/${outlet}-store/stockTemplates/weekly`).set({ name: "Weekly", items: [{ catalogProductId: "juice" }] });
    }
    await db.doc(`hotels/${hotel}/suppliers/vendor`).set({ name: "Juice supplier", orderSystem: "Email", orderEmail: "supplier@example.test" });
    await db.doc(`hotels/${hotel}/supplierproducts/juice-case`).set({ supplierId: "vendor", supplierSku: "JUICE-6", supplierProductName: "Orange juice",
      catalogProductId: "juice", productPolicyVersion: 1, active: true, purchaseUnit: "Case of six", baseUnit: "l", baseUnitsPerPurchaseUnit: 6,
      pricePerPurchaseUnit: 12, currency: "EUR", priceBasis: "net", vatRate: null });
  }
  for (const actor of [staffA, staffB]) await db.doc(`${hotelPath}/members/${actor.uid}`).set({ permissions });
  await db.doc(`hotels/hotel-b/members/${outsider.uid}`).set({ permissions });
});
after(async () => environment.cleanup());

describe("reliable collaboration with real Auth and Firestore transactions", () => {
  it("saves different count locations concurrently and preserves both users and aggregate values", async () => {
    const { stockCountId } = await createCount();
    const results = await Promise.all([
      saveLocation(staffA, locationInput(stockCountId, "bar-store", 2)),
      saveLocation(staffB, locationInput(stockCountId, "kitchen-store", 3)),
    ]);
    assert.deepEqual(results.map((result) => result.locationRevision), [1, 1]);
    assert.deepEqual(results.map((result) => result.revision).sort(), [1, 2]);
    const parent = (await db.doc(countPath(stockCountId)).get()).data();
    assert.equal(parent.countedValue, 10);
    assert.equal(parent.revision, 2);
    for (const [locationId, quantity, actor] of [["bar-store", 2, staffA], ["kitchen-store", 3, staffB]]) {
      const location = (await db.doc(`${countPath(stockCountId)}/locations/${locationId}`).get()).data();
      assert.equal(location.countedItems[0].quantity, quantity);
      assert.equal(location.countedItems[0].countedBy, actor.uid);
      assert.equal(location.updatedBy, actor.uid);
      assert.ok(location.countedItems[0].countedAt.toMillis() > 0);
    }
  });

  it("rejects the losing edit to the same location without replacing the winning count", async () => {
    const { stockCountId } = await createCount();
    const inputs = [locationInput(stockCountId, "bar-store", 2), locationInput(stockCountId, "bar-store", 3)];
    const actors = [staffA, staffB];
    const results = await Promise.allSettled(inputs.map((input, index) => saveLocation(actors[index], input)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const loser = results.find((result) => result.status === "rejected");
    assert.equal(loser.reason.code, "aborted");
    assert.equal(loser.reason.details.conflictScope, "location");
    assert.equal(loser.reason.details.countMutationUncommitted, true);
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const saved = (await db.doc(`${countPath(stockCountId)}/locations/bar-store`).get()).data();
    assert.equal(saved.revision, 1);
    assert.equal(saved.countedItems[0].quantity, inputs[winnerIndex].countedItems[0].quantity);
    assert.equal(saved.updatedBy, actors[winnerIndex].uid);
  });

  it("finishes independent locations atomically, replays acknowledged requests, and keeps completed counts immutable", async () => {
    const { stockCountId } = await createCount();
    const finishParent = (expectedRevision) => saveLocation(staffA, { hotelUid: "hotel-a", stockCountId, action: "finish-count", expectedRevision, requestId: next() });
    await rejected(finishParent(0), "failed-precondition");
    await rejected(saveLocation(staffA, locationInput(stockCountId, "bar-store", null, 0, "finish-location")), "failed-precondition");
    const inputs = [locationInput(stockCountId, "bar-store", 2, 0, "finish-location"), locationInput(stockCountId, "kitchen-store", 0, 0, "finish-location")];
    const results = await Promise.all([saveLocation(staffA, inputs[0]), saveLocation(staffB, inputs[1])]);
    const finished = await finishParent(2);
    assert.equal(finished.status, "Finished");
    assert.equal(finished.countedValue, 4);
    assert.deepEqual(await saveLocation(staffA, inputs[0]), results[0]);
    await rejected(saveLocation(staffB, locationInput(stockCountId, "bar-store", 9, 1)), "failed-precondition");
    assert.equal((await db.collection(`${hotelPath}/inventoryCheckpoints`).get()).size, 2);
    assert.equal((await db.doc(countPath(stockCountId)).get()).data().revision, 3);
  });

  it("splits two bar cases and three kitchen cases into separate orders with their own notes", async () => {
    const initial = await newCart();
    await mutateCart(staffA, lineInput(initial.cartId, initial.items[0], "note", "Deliver to bar counter"));
    const noted = await readCart(initial.cartId);
    await mutateCart(staffA, lineInput(initial.cartId, noted.items[0], "split", { quantity: 3, outletId: "kitchen" }));
    const split = await readCart(initial.cartId);
    assert.equal(new Set(split.items.map((line) => line.lineId)).size, 2);
    const kitchen = split.items.find((line) => line.outletId === "kitchen");
    await mutateCart(staffB, lineInput(initial.cartId, kitchen, "note", "Keep for breakfast"));
    const current = await readCart(initial.cartId);
    await rejected(mutateCart(staffA, { cartId: initial.cartId, action: "quantity", productId: "juice-case", value: 9, expectedRevision: current.revision }), "failed-precondition");
    const created = await submit(staffA, submission(initial.cartId, current.revision));
    assert.equal(created.orderIds.length, 2);
    const orders = await Promise.all(created.orderIds.map(async (id) => (await db.doc(`${hotelPath}/orders/${id}`).get()).data()));
    const summary = orders.map((order) => ({ outlet: order.outletId, quantity: order.products[0].qtyPurchaseUnits, note: order.products[0].note, total: order.totalAmount })).sort((a, b) => a.outlet.localeCompare(b.outlet));
    assert.deepEqual(summary, [{ outlet: "bar", quantity: 2, note: "Deliver to bar counter", total: 24 }, { outlet: "kitchen", quantity: 3, note: "Keep for breakfast", total: 36 }]);
    assert.ok(orders.every((order) => order.status === "Created" && order.currency === "EUR" && order.priceBasis === "net" && order.createdBy === staffA.uid));
    const emptied = await readCart(initial.cartId);
    assert.deepEqual(emptied.items, []);
    assert.equal(emptied.updatedBy, staffA.uid);
  });

  it("keeps independent cart line edits while rejecting a competing edit to one line", async () => {
    const initial = await newCart();
    await mutateCart(staffA, lineInput(initial.cartId, initial.items[0], "split", { quantity: 3, outletId: "kitchen" }));
    const split = await readCart(initial.cartId);
    await Promise.all(split.items.map((line, index) => mutateCart(index ? staffB : staffA, lineInput(initial.cartId, line, "note", `${line.outletId} delivery`))));
    const current = await readCart(initial.cartId);
    assert.deepEqual(current.items.map((line) => line.note).sort(), ["bar delivery", "kitchen delivery"]);
    const target = current.items[0];
    const results = await Promise.allSettled([mutateCart(staffA, lineInput(initial.cartId, target, "quantity", 4)), mutateCart(staffB, lineInput(initial.cartId, target, "quantity", 6))]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "aborted");
    const saved = await readCart(initial.cartId);
    assert.equal(saved.items.find((line) => line.lineId === target.lineId).qtyPurchaseUnits, results[0].status === "fulfilled" ? 4 : 6);
    assert.deepEqual(saved.items.filter((line) => line.lineId !== target.lineId), current.items.filter((line) => line.lineId !== target.lineId));
  });

  it("allows only one of two distinct actors to submit the same reviewed cart and replays the winner", async () => {
    const cart = await newCart(2);
    const actors = [staffA, staffB], inputs = [submission(cart.cartId, cart.revision), submission(cart.cartId, cart.revision)];
    const results = await Promise.allSettled(inputs.map((input, index) => submit(actors[index], input)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "aborted");
    const winner = results.findIndex((result) => result.status === "fulfilled");
    assert.deepEqual(await submit(actors[winner], inputs[winner]), results[winner].value);
    await rejected(submit(actors[winner], { ...inputs[winner], requestId: next() }), "aborted");
    assert.equal((await db.collection(`${hotelPath}/orders`).get()).size, 1);
    assert.equal((await db.collection(`${hotelPath}/orderOperations`).get()).size, 1);
    assert.equal((await readCart(cart.cartId)).revision, cart.revision + 1);
  });

  it("serializes submission against a simultaneous quantity edit without losing an accepted edit", async () => {
    const cart = await newCart(2);
    const results = await Promise.allSettled([
      submit(staffA, submission(cart.cartId, cart.revision)),
      mutateCart(staffB, lineInput(cart.cartId, cart.items[0], "quantity", 3)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedResult = results.find((result) => result.status === "rejected");
    assert.ok(["aborted", "not-found"].includes(rejectedResult.reason.code));
    if (results[1].status === "fulfilled") {
      const edited = await readCart(cart.cartId);
      assert.equal(edited.items[0].qtyPurchaseUnits, 3);
      assert.equal((await db.collection(`${hotelPath}/orders`).get()).size, 0);
      await submit(staffA, submission(cart.cartId, edited.revision));
    }
    const orders = await db.collection(`${hotelPath}/orders`).get();
    assert.equal(orders.size, 1);
    assert.equal(orders.docs[0].data().products[0].qtyPurchaseUnits, results[1].status === "fulfilled" ? 3 : 2);
    assert.deepEqual((await readCart(cart.cartId)).items, []);
  });

  it("retains hotel and permission boundaries for new line identities and recoverable count commands", async () => {
    const { stockCountId } = await createCount();
    const cart = await newCart(2);
    await rejected(saveLocation(outsider, locationInput(stockCountId, "bar-store", 2)), "permission-denied");
    await rejected(mutateCart(outsider, lineInput(cart.cartId, cart.items[0], "quantity", 3)), "permission-denied");
    await rejected(submit(outsider, submission(cart.cartId, cart.revision)), "permission-denied");
    await db.doc("hotels/hotel-b/outlets/foreign-only").set({ name: "Other hotel's outlet" });
    await rejected(mutateCart(staffA, lineInput(cart.cartId, cart.items[0], "split", { quantity: 1, outletId: "foreign-only" })), "not-found");
    const savedInput = locationInput(stockCountId, "bar-store", 2);
    await saveLocation(staffA, savedInput);
    await db.doc(`${hotelPath}/members/${staffA.uid}`).update({ permissions: ["orders.read", "stockcounts.read"] });
    await assert.rejects(saveLocation(staffA, savedInput), (error) => error.code === "permission-denied" && error.details?.countMutationUncommitted !== true);
    const client = environment.authenticatedContext(staffB.uid, staffB.token).firestore();
    await assertFails(updateDoc(doc(client, `${hotelPath}/shoppingCarts/${cart.cartId}`), { items: [] }));
    await assertFails(updateDoc(doc(client, `${countPath(stockCountId)}/locations/bar-store`), { revision: 99 }));
    await assertFails(setDoc(doc(client, `${countPath(stockCountId)}/commands/forged`), { result: { revision: 99 } }));
  });
});
