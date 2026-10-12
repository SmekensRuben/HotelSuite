import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Combobox } from "./combobox";

afterEach(cleanup);
const options = [{ id: "one", name: "Orange juice" }, { id: "two", name: "Apple juice" }];
function Picker({ changed = () => {}, ...props }) {
  const [value, setValue] = useState(null);
  return <><label htmlFor="drink">Drink</label><Combobox id="drink" value={value} onChange={(option) => { setValue(option); changed(option); }}
    options={options} displayValue={(option) => option.name} getOptionValue={(option) => option.id} {...props} /><button>Other control</button></>;
}
it("supports keyboard navigation and commits only the chosen option", () => {
  const changed = vi.fn(); render(<Picker changed={changed} />);
  const input = screen.getByRole("combobox", { name: "Drink" });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Apple juice" }).id);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(changed).toHaveBeenCalledWith(options[1]); expect(input).toHaveValue("Apple juice"); expect(input).toHaveAttribute("aria-expanded", "false");
});
it("never silently selects the first result when a search loses focus", () => {
  const changed = vi.fn(); render(<Picker changed={changed} />);
  const input = screen.getByRole("combobox"); fireEvent.focus(input); fireEvent.change(input, { target: { value: "juice" } });
  fireEvent.blur(input, { relatedTarget: screen.getByText("Other control") });
  expect(changed).not.toHaveBeenCalled(); expect(input).toHaveValue("");
});
it("requires an actual selection rather than accepting arbitrary typed text", () => {
  render(<Picker required />); const input = screen.getByRole("combobox");
  fireEvent.focus(input); fireEvent.change(input, { target: { value: "Invented drink" } });
  expect(input.checkValidity()).toBe(false);
  fireEvent.change(input, { target: { value: "Orange" } }); fireEvent.click(screen.getByRole("option", { name: "Orange juice" }));
  expect(input.checkValidity()).toBe(true);
});
it("searches the complete option set while bounding the visible list explicitly", () => {
  const choices = Array.from({ length: 150 }, (_, index) => ({ id: String(index), name: "Product " + index }));
  render(<Picker options={choices} />); const input = screen.getByRole("combobox"); fireEvent.focus(input);
  expect(screen.getAllByRole("option")).toHaveLength(80); expect(screen.getByText(/Showing 80 of 150 matches/)).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "Product 149" } }); expect(screen.getByRole("option", { name: "Product 149" })).toBeInTheDocument();
});
it("exposes asynchronous search/loading without committing unavailable choices", () => {
  const changed = vi.fn(), queried = vi.fn(); render(<Picker changed={changed} loading onQueryChange={queried} />);
  const input = screen.getByRole("combobox"); fireEvent.focus(input); fireEvent.change(input, { target: { value: "orange" } }); fireEvent.keyDown(input, { key: "Enter" });
  expect(queried).toHaveBeenLastCalledWith("orange"); expect(screen.getByRole("status")).toHaveTextContent("Loading options"); expect(changed).not.toHaveBeenCalled();
});
it("clears a selection explicitly and Escape preserves an existing selection", () => {
  const changed = vi.fn(); render(<Picker changed={changed} allowClear />); const input = screen.getByRole("combobox");
  fireEvent.focus(input); fireEvent.click(screen.getByRole("option", { name: "Orange juice" }));
  fireEvent.focus(input); fireEvent.change(input, { target: { value: "Apple" } }); fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("Orange juice"); expect(changed).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" })); expect(changed).toHaveBeenLastCalledWith(null);
});

it("keeps portalled option pointer clicks internal and reopens a still-focused selected input", () => {
  const changed = vi.fn(); render(<Picker changed={changed} />); const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  const first = screen.getByRole("option", { name: "Orange juice" });
  fireEvent.pointerDown(first); fireEvent.mouseDown(first); fireEvent.click(first);
  expect(changed).toHaveBeenLastCalledWith(options[0]); expect(input).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(input); expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "Apple juice" }));
  expect(changed).toHaveBeenLastCalledWith(options[1]); expect(input).toHaveValue("Apple juice");
});
