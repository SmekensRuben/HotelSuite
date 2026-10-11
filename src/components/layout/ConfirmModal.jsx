import React from "react";
import { Dialog } from "@headlessui/react";
import { useTranslation } from "react-i18next";

export default function ConfirmModal({ open, title, message, onConfirm, onCancel }) {
  const { t } = useTranslation("ingredients");

  return (
    <Dialog open={open} onClose={onCancel} className="fixed inset-0 z-[60] overflow-hidden">
      <div className="fixed inset-0 bg-brand-950/40 backdrop-blur-sm" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel className="ht-panel shadow-lifted p-6 max-w-md w-full mx-4 text-center">
          <Dialog.Title className="font-display text-2xl text-brand-950 mb-3">
            {title}
          </Dialog.Title>
          <p className="text-gray-600 mb-6">{message}</p>
          <div className="flex justify-center gap-4">
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-gray-200 text-gray-700 hover:bg-gray-300"
            >
              {t("cancel")}
            </button>
            <button
              onClick={onConfirm}
              className="px-4 py-2 rounded-lg bg-brand-800 text-white hover:bg-brand-950"
            >
              {t("confirm")}
            </button>
          </div>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
