import React, { useEffect, useState } from "react";
import { Dialog } from "@headlessui/react";

export default function PasswordPromptModal({
  open,
  onConfirm,
  onCancel,
  loading = false,
  error = "",
  title = "Bevestig wachtwoord",
  description = "Voer je wachtwoord in om deze gegevens te bekijken.",
  confirmLabel = "Bevestigen",
  cancelLabel = "Annuleren",
}) {
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (open) {
      setPassword("");
    }
  }, [open]);

  const handleSubmit = event => {
    event.preventDefault();
    if (loading) return;
    onConfirm?.(password);
  };

  return (
    <Dialog open={open} onClose={onCancel} className="fixed inset-0 z-[70] overflow-hidden">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <Dialog.Title className="text-lg font-semibold text-gray-900">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-600">{description}</Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="password-confirmation" className="text-sm font-medium text-gray-700">
                Wachtwoord
              </label>
              <input
                id="password-confirmation"
                type="password"
                className="w-full rounded border border-gray-300 px-3 py-2 focus:border-marriott focus:outline-none focus:ring-2 focus:ring-marriott/30"
                value={password}
                onChange={event => setPassword(event.target.value)}
                disabled={loading}
                autoFocus
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="rounded border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
                disabled={loading}
              >
                {cancelLabel}
              </button>
              <button
                type="submit"
                className="rounded bg-marriott px-4 py-2 text-sm font-semibold text-white hover:bg-marriott/90 disabled:opacity-60"
                disabled={loading || password.trim() === ""}
              >
                {loading ? "Bevestigen…" : confirmLabel}
              </button>
            </div>
          </form>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
