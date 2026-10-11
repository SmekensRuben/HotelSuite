import React from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";

export default function Modal({ open, onClose, title, children }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="fixed inset-0 z-50"
      aria-label={title ? undefined : "Dialog"}
    >
      <div
        className="fixed inset-0 bg-brand-950/40 backdrop-blur-sm"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="ht-panel relative max-h-[90dvh] w-full max-w-md overflow-y-auto p-6 shadow-lifted">
          <div className="mb-5 flex items-start justify-between gap-4">
            {title ? (
              <DialogTitle className="font-display text-2xl tracking-tight text-brand-950">
                {title}
              </DialogTitle>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={onClose}
              className="ht-icon-button"
              aria-label="Close dialog"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          {children}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
