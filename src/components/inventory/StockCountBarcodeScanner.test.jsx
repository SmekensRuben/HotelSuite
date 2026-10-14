// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StockCountBarcodeScanner from "./StockCountBarcodeScanner";
let frames, stop, detect, media;
const setupCamera = () => {
  stop = vi.fn(); detect = vi.fn().mockResolvedValue([]); media = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
  function Detector() { this.detect = detect; }
  Detector.getSupportedFormats = vi.fn().mockResolvedValue(["ean_13", "code_128"]);
  vi.stubGlobal("BarcodeDetector", Detector);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: media } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
};
beforeEach(() => {
  frames = new Map(); let next = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((fn) => { const id = ++next; frames.set(id, fn); return id; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id) => frames.delete(id)));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined }); });

it("keeps keyboard barcode entry available when camera detection is unsupported", () => {
  const onScan = vi.fn(); render(<StockCountBarcodeScanner onScan={onScan} onClose={vi.fn()} scopeKey="bar" />);
  expect(screen.queryByRole("button", { name: "Use camera" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Product barcode"), { target: { value: " 0000123456789 " } }); fireEvent.submit(screen.getByLabelText("Product barcode").closest("form"));
  expect(onScan).toHaveBeenCalledWith("0000123456789");
});

it("opens the camera only after a tap and closes every track when the scanner unmounts", async () => {
  setupCamera(); const view = render(<StockCountBarcodeScanner onScan={vi.fn()} onClose={vi.fn()} scopeKey="bar" />);
  expect(media).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Use camera" }));
  await waitFor(() => expect(frames.size).toBe(1)); expect(media).toHaveBeenCalledWith({ video: { facingMode: { ideal: "environment" } }, audio: false });
  view.unmount(); expect(stop).toHaveBeenCalled(); expect(frames.size).toBe(0);
});

it("finds a camera barcode once and stops streaming before passing it to the count", async () => {
  setupCamera(); detect.mockResolvedValue([{ rawValue: "000123" }]); const onScan = vi.fn(() => expect(stop).toHaveBeenCalled());
  render(<StockCountBarcodeScanner onScan={onScan} onClose={vi.fn()} scopeKey="bar" />); fireEvent.click(screen.getByRole("button", { name: "Use camera" }));
  await waitFor(() => expect(frames.size).toBe(1));
  await act(async () => { const [id, callback] = [...frames][0]; frames.delete(id); await callback(); });
  expect(onScan).toHaveBeenCalledTimes(1); expect(onScan).toHaveBeenCalledWith("000123"); expect(screen.queryByLabelText("Barcode camera")).not.toBeInTheDocument();
});

it("cleans up a delayed camera grant after the count scope changes", async () => {
  setupCamera(); let resolve; media.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = render(<StockCountBarcodeScanner onScan={vi.fn()} onClose={vi.fn()} scopeKey="hotel-a" />); fireEvent.click(screen.getByRole("button", { name: "Use camera" }));
  await waitFor(() => expect(resolve).toBeTypeOf("function")); view.rerender(<StockCountBarcodeScanner onScan={vi.fn()} onClose={vi.fn()} scopeKey="hotel-b" />);
  await act(async () => resolve({ getTracks: () => [{ stop }] }));
  expect(stop).toHaveBeenCalled(); expect(screen.queryByLabelText("Barcode camera")).not.toBeInTheDocument(); expect(frames.size).toBe(0);
});

it("retains manual entry after the user declines camera access", async () => {
  setupCamera(); media.mockRejectedValue(Object.assign(new Error("Denied"), { name: "NotAllowedError" }));
  render(<StockCountBarcodeScanner onScan={vi.fn()} onClose={vi.fn()} scopeKey="bar" />); fireEvent.click(screen.getByRole("button", { name: "Use camera" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Camera access was declined"); expect(screen.getByLabelText("Product barcode")).toBeEnabled(); expect(frames.size).toBe(0);
});

it("keeps scanning when multiple distinct barcodes are in view instead of choosing an arbitrary product", async () => {
  setupCamera(); detect.mockResolvedValueOnce([{ rawValue: "000123" }, { rawValue: "000456" }]).mockResolvedValueOnce([{ rawValue: "000456" }]); const onScan = vi.fn();
  render(<StockCountBarcodeScanner onScan={onScan} onClose={vi.fn()} scopeKey="bar" />); fireEvent.click(screen.getByRole("button", { name: "Use camera" }));
  await waitFor(() => expect(frames.size).toBe(1));
  await act(async () => { const [id, callback] = [...frames][0]; frames.delete(id); await callback(); });
  expect(screen.getByRole("status")).toHaveTextContent("Multiple barcodes are in view"); expect(onScan).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
  await act(async () => { const [id, callback] = [...frames][0]; frames.delete(id); await callback(); });
  expect(onScan).toHaveBeenCalledWith("000456"); expect(stop).toHaveBeenCalled();
});
