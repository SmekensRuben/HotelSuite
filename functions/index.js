const { syncCatalogProductsToMeili, syncSupplierProductsToMeili, syncFileImportSettingsIndex, syncFileImportTypesIndex } = require("./src/meili");
const { handleResendEmailReceivedWebhook } = require("./src/webhook");
const { processMailQueue } = require("./src/mailQueue");
const { sendContractCancellationReminders, runContractCancellationRemindersNow } = require("./src/contracts");
const { sendOrderApprovalEmailToApprovers } = require("./src/approvals");
const { sendOrderedSupplierOrder } = require("./src/sftpDispatch");
const { processImportedFileToFirestore } = require("./src/fileImportTypes");
const { sendScheduledOccupancyMail, runScheduledOccupancyMailNow } = require("./src/occupancyMail");
const { sendScheduledBlockPickupReport } = require("./src/blockPickupMail");
const { processScheduledAuditUpsells } = require("./src/auditUpsell");
const { linkLatestArrivalDescriptions, listArrivalDates } = require("./src/arrivals");
const { processNightlyGuestIntelligence } = require("./src/guestIntelligence");
const { sendScheduledGuestIntelligenceMail } = require("./src/guestIntelligenceMail");
const { rebuildStayPatternModelCallable } = require("./src/stayPatternModel");
const { updateUserAccess } = require("./src/userAccess");
const { setHotelSubscription, listHotelSubscriptions } = require("./src/subscriptions");
const { searchHotelProducts } = require("./src/productSearch");

exports.syncCatalogProductsToMeili = syncCatalogProductsToMeili;
exports.syncSupplierProductsToMeili = syncSupplierProductsToMeili;
exports.syncFileImportSettingsIndex = syncFileImportSettingsIndex;
exports.syncFileImportTypesIndex = syncFileImportTypesIndex;
exports.handleResendEmailReceivedWebhook = handleResendEmailReceivedWebhook;
exports.processMailQueue = processMailQueue;
exports.sendContractCancellationReminders = sendContractCancellationReminders;
exports.runContractCancellationRemindersNow = runContractCancellationRemindersNow;
exports.sendOrderApprovalEmailToApprovers = sendOrderApprovalEmailToApprovers;
exports.sendOrderedSupplierOrder = sendOrderedSupplierOrder;

exports.processImportedFileToFirestore = processImportedFileToFirestore;

exports.sendScheduledOccupancyMail = sendScheduledOccupancyMail;
exports.runScheduledOccupancyMailNow = runScheduledOccupancyMailNow;

exports.sendScheduledBlockPickupReport = sendScheduledBlockPickupReport;
exports.processScheduledAuditUpsells = processScheduledAuditUpsells;
exports.listArrivalDates = listArrivalDates;
exports.linkLatestArrivalDescriptions = linkLatestArrivalDescriptions;
exports.processNightlyGuestIntelligence = processNightlyGuestIntelligence;
exports.sendScheduledGuestIntelligenceMail = sendScheduledGuestIntelligenceMail;
exports.rebuildStayPatternModel = rebuildStayPatternModelCallable;
exports.updateUserAccess = updateUserAccess;
exports.setHotelSubscription = setHotelSubscription;
exports.listHotelSubscriptions = listHotelSubscriptions;
exports.searchHotelProducts = searchHotelProducts;

// Protected SaaS onboarding and procurement boundaries.
const onboarding = require("./src/onboarding");
const suppliers = require("./src/suppliers");
const orders = require("./src/orders");
for (const name of ["createHotel", "inviteHotelUser", "listHotelUsers", "getHotelOnboardingStatus"]) exports[name] = onboarding[name];
for (const name of ["listSuppliers", "getSupplierConnection", "saveSupplier", "deleteSupplier", "migrateSupplierCredentials"]) exports[name] = suppliers[name];
for (const name of ["createOrdersFromCart", "updateHotelOrder", "deleteHotelOrder", "confirmHotelOrder", "setHotelOutletApprovers", "saveSupplierOutletAccount"]) exports[name] = orders[name];
exports.mutateHotelShoppingCart = require("./src/shoppingCarts").mutateHotelShoppingCart;
exports.reviewHotelOrderDelivery = require("./src/deliveryRecovery").reviewHotelOrderDelivery;

const contractFiles = require("./src/contractFiles");
for (const name of ["listHotelContracts", "listContractFollowers", "saveHotelContract", "contractDocument"]) exports[name] = contractFiles[name];

const roomingLists = require("./src/roomingLists");
for (const name of ["getRoomingList", "createRoomingList", "mutateRoomingList", "reviewRoomingList", "setRoomingListAccess"]) exports[name] = roomingLists[name];
