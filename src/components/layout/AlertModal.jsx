import React from "react";
import { Dialog } from "@headlessui/react";

export default function AlertModal({ open, title, message, onClose }) {
  if (!open) return null;

  return (
    <Dialog open={open} onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40 z-50" aria-hidden="true" />
      <Dialog.Panel className="relative z-[60] bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full mx-4">
        {title && (
          <Dialog.Title className="text-lg font-semibold mb-4 text-center sm:text-left">
            {title}
          </Dialog.Title>
        )}
        {typeof message === "string" ? <p className="mb-4">{message}</p> : message}
        <div className="flex justify-end">
          <button
            type="button"
            className="bg-marriott text-white px-4 py-2 rounded-2xl font-semibold hover:bg-marriott-dark"
            onClick={onClose}
          >
            Ok
          </button>
        </div>
      </Dialog.Panel>
    </Dialog>
  );
}
