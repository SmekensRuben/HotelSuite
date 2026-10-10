import React, { useCallback } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useScopedAsync } from "./useScopedAsync";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function Harness({ scope, loader, retainData = false, captureRun }) {
  const load = useCallback((...args) => loader(scope, ...args), [scope, loader]);
  const query = useScopedAsync({ scopeKey: scope, retainData, load });
  if (captureRun) captureRun(query.run);
  return <><p>{query.data || (query.loading ? "Loading" : "Empty")}</p>{query.error && <p role="alert">{query.error.message}</p>}<button onClick={query.retry}>Retry</button><button onClick={() => query.run("new")}>Next</button></>;
}

describe("useScopedAsync", () => {
  it("completes rejected loading and retries the same request", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue("Recovered");
    render(<Harness scope="hotel-a" loader={loader} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByText("Empty")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("Recovered")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("ignores responses from a previous hotel and clears previous data immediately", async () => {
    const first = deferred(), second = deferred();
    const loader = vi.fn((scope) => scope === "hotel-a" ? first.promise : second.promise);
    const view = render(<Harness scope="hotel-a" loader={loader} />);
    view.rerender(<Harness scope="hotel-b" loader={loader} />);
    await act(async () => second.resolve("Hotel B"));
    expect(screen.getByText("Hotel B")).toBeInTheDocument();
    await act(async () => first.resolve("Hotel A"));
    expect(screen.queryByText("Hotel A")).not.toBeInTheDocument();
    expect(screen.getByText("Hotel B")).toBeInTheDocument();
  });
  it("ignores reversed requests within one scope, including obsolete failures", async () => {
    const first = deferred(), second = deferred();
    const loader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Harness scope="hotel-a:filter" loader={loader} />);
    fireEvent.click(screen.getByText("Next"));
    await act(async () => second.resolve("Newest"));
    await act(async () => first.reject(new Error("Obsolete")));
    expect(screen.getByText("Newest")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("retains data during same-scope refresh and failure, but clears it for another hotel", async () => {
    const pending = deferred(), nextHotel = deferred();
    const loader = vi.fn().mockResolvedValueOnce("Hotel A").mockReturnValueOnce(pending.promise).mockReturnValueOnce(nextHotel.promise);
    const view = render(<Harness scope="hotel-a" loader={loader} retainData />);
    await screen.findByText("Hotel A");
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Hotel A")).toBeInTheDocument();
    await act(async () => pending.reject(new Error("Refresh offline")));
    expect(screen.getByText("Hotel A")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh offline");
    view.rerender(<Harness scope="hotel-b" loader={loader} retainData />);
    expect(screen.queryByText("Hotel A")).not.toBeInTheDocument();
    await act(async () => nextHotel.resolve("Hotel B"));
    expect(screen.getByText("Hotel B")).toBeInTheDocument();
  });
  it("does not start a previous-scope callback after a hotel switch", async () => {
    let currentRun;
    const loader = vi.fn().mockResolvedValue("Current record");
    const captureRun = (run) => { currentRun = run; };
    const view = render(<Harness scope="hotel-a" loader={loader} captureRun={captureRun} />);
    await screen.findByText("Current record");
    const staleRun = currentRun;
    view.rerender(<Harness scope="hotel-b" loader={loader} captureRun={captureRun} />);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await act(async () => staleRun());
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Current record")).toBeInTheDocument();
  });
});
