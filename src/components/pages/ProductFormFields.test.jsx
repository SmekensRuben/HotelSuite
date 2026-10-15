import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProductFormFields from "./ProductFormFields";

const mocks = vi.hoisted(() => ({ taxonomy: vi.fn() }));
vi.mock("../../services/firebaseSettings", () => ({ getCatalogTaxonomy: mocks.taxonomy }));
vi.mock("../../services/firebaseProducts", () => ({ uploadCatalogProductImage: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));

const taxonomy = {
  categories: [{ id: "food", name: "Food" }, { id: "drinks", name: "Drinks" }],
  subcategories: [
    { id: "dairy", name: "Dairy", categoryId: "food" },
    { id: "juice", name: "Juice", categoryId: "drinks" },
  ],
};
const categoryField = () => screen.getByRole("combobox", { name: "products.fields.category" });
const subcategoryField = () => screen.getByRole("combobox", { name: "products.fields.subcategory" });
const choose = async (input, name) => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(await screen.findByRole("option", { name }));
};
const clear = (input) => fireEvent.click(within(input.parentElement).getByRole("button", { name: "Clear selection" }));

function renderForm(initialData = {}) {
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<ProductFormFields hotelUid="hotel-a" initialData={{ name: "Milk", baseUnit: "l", ...initialData }} onSubmit={submit} submitLabel="Save" savingLabel="Saving" />);
  return submit;
}
const ready = () => waitFor(() => expect(categoryField()).not.toBeDisabled());
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

describe("catalog product classification choices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.taxonomy.mockResolvedValue(taxonomy);
  });

  it("searches existing hotel categories and saves a matching subcategory", async () => {
    const submit = renderForm();
    expect(subcategoryField()).toBeDisabled();
    await ready();
    expect(mocks.taxonomy).toHaveBeenCalledWith("hotel-a");
    await choose(categoryField(), "Food");
    fireEvent.focus(subcategoryField());
    expect(screen.getByRole("option", { name: "Dairy" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Juice" })).not.toBeInTheDocument();
    fireEvent.keyDown(subcategoryField(), { key: "ArrowDown" });
    fireEvent.keyDown(subcategoryField(), { key: "Enter" });
    save();
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ category: "Food", subcategory: "Dairy" })));
  });

  it("restores existing selections when editing and preserves the child when reselecting its category", async () => {
    const submit = renderForm({ category: "Food", subcategory: "Dairy" });
    await ready();
    expect(categoryField()).toHaveValue("Food");
    expect(subcategoryField()).toHaveValue("Dairy");
    await choose(categoryField(), "Food");
    expect(subcategoryField()).toHaveValue("Dairy");
    save();
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ category: "Food", subcategory: "Dairy" })));
  });

  it("clears the child on category changes and allows the complete classification to be cleared", async () => {
    const submit = renderForm({ category: "Food", subcategory: "Dairy" });
    await ready();
    await choose(categoryField(), "Drinks");
    expect(subcategoryField()).toHaveValue("");
    fireEvent.focus(subcategoryField());
    expect(screen.queryByRole("option", { name: "Dairy" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Juice" }));
    clear(categoryField());
    expect(subcategoryField()).toHaveValue("");
    expect(subcategoryField()).toBeDisabled();
    fireEvent.blur(categoryField());
    save();
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ category: "", subcategory: "" })));
  });

  it("treats arbitrary typed text as a search rather than a new classification", async () => {
    const submit = renderForm({ category: "Food", subcategory: "Dairy" });
    await ready();
    for (const input of [categoryField(), subcategoryField()]) {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Invented classification" } });
      expect(within(screen.getByRole("listbox")).queryByRole("option")).not.toBeInTheDocument();
      fireEvent.blur(input);
    }
    expect(categoryField()).toHaveValue("Food");
    expect(subcategoryField()).toHaveValue("Dairy");
    save();
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ category: "Food", subcategory: "Dairy" })));
  });

  it.each([
    [{ category: "Removed category", subcategory: "Dairy" }, "Choose an existing catalog category"],
    [{ category: "Drinks", subcategory: "Dairy" }, "Choose an existing subcategory"],
  ])("requires an existing, correctly related selection before resaving %j", async (initialData, message) => {
    const submit = renderForm(initialData);
    await ready();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(submit).not.toHaveBeenCalled();
    await choose(categoryField(), "Food");
    await choose(subcategoryField(), "Dairy");
    save();
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ category: "Food", subcategory: "Dairy" })));
  });

  it("keeps failed taxonomy loads unavailable and allows retry before saving a classification", async () => {
    mocks.taxonomy.mockRejectedValueOnce(new Error("Offline"));
    const submit = renderForm({ category: "Food", subcategory: "Dairy" });
    expect(categoryField()).toBeDisabled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load catalog categories.");
    expect(categoryField()).toBeDisabled();
    expect(subcategoryField()).toBeDisabled();
    save();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await ready();
    save();
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ category: "Food", subcategory: "Dairy" })));
  });
});
