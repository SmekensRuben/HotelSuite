import React from "react";
import { it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SupplierFormFields from "./SupplierFormFields";

it("omits every credential field for an editor without credential-management access", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<SupplierFormFields initialValues={{ name: "Supplier", username: "fictional-private-name" }} onSubmit={save} />);
  expect(screen.queryByLabelText("Username")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  for (const key of ["username", "password", "sftpPassword", "sftpUser", "sftpHostKey"]) expect(save.mock.calls[0][0][key]).toBeUndefined();
});

it("keeps password characters intact and makes a failed save retryable", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Supplier changed. Reload before saving."));
  render(<SupplierFormFields canManageCredentials initialValues={{ name: "Supplier" }} onSubmit={save} />);
  fireEvent.change(screen.getByLabelText("Password · leave blank to keep"), { target: { value: " fictional-password " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(save.mock.calls[0][0].password).toBe(" fictional-password ");
  expect(screen.getByRole("button", { name: "Save" }).disabled).toBe(false);
});
