import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import CartQuantityInput from "./CartQuantityInput";

it("does not delete a kg line while entering the zero prefix of a fractional quantity", async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<CartQuantityInput quantity={1} purchaseUnit="kg" revision={7} onCommit={save} />);
  const input = screen.getByRole("spinbutton");
  fireEvent.change(input, { target: { value: "0" } }); expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "0.25" } }); expect(save).not.toHaveBeenCalled();
  await act(async () => fireEvent.blur(input)); expect(save).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledWith(0.25, 7);
});
it("pins the revision when editing starts rather than overwriting a later external cart change", async () => {
  const save = vi.fn().mockResolvedValue(false);
  const view = render(<CartQuantityInput quantity={1} purchaseUnit="kg" revision={7} onCommit={save} />);
  const input = screen.getByRole("spinbutton"); fireEvent.change(input, { target: { value: "0.25" } });
  view.rerender(<CartQuantityInput quantity={3} purchaseUnit="kg" revision={9} onCommit={save} />);
  await act(async () => fireEvent.blur(input)); expect(save).toHaveBeenCalledWith(0.25, 7); expect(input).toHaveValue(0.25);
  fireEvent.click(screen.getByRole("button", { name: "Use latest quantity" })); expect(input).toHaveValue(3);
});
it("keeps blank input unknown and an explicit zero distinct", async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<CartQuantityInput quantity={1} purchaseUnit="kg" revision={7} onCommit={save} />);
  const input = screen.getByRole("spinbutton"); fireEvent.change(input, { target: { value: "" } });
  await act(async () => fireEvent.blur(input)); expect(save).not.toHaveBeenCalled(); await screen.findByRole("alert");
  fireEvent.change(input, { target: { value: "0" } }); await act(async () => fireEvent.blur(input)); expect(save).toHaveBeenCalledWith(0, 7);
});
it("does not send another command while a quantity acknowledgment is pending", async () => {
  let resolve; const save = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<CartQuantityInput quantity={1} purchaseUnit="kg" revision={7} onCommit={save} />);
  const input = screen.getByRole("spinbutton"); fireEvent.change(input, { target: { value: "0.25" } }); fireEvent.blur(input);
  await waitFor(() => expect(input).toBeDisabled()); fireEvent.blur(input); expect(save).toHaveBeenCalledTimes(1);
  await act(async () => resolve(false)); expect(input).toHaveValue(0.25); expect(save).toHaveBeenCalledTimes(1);
});
