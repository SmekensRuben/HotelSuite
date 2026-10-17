import React from "react";
import { useHotelContext } from "../../contexts/HotelContext";
import { purchasingProcessForPath, reportPurchasingError } from "../../services/firebasePurchasingTelemetry";

export function PurchasingErrorBoundary({ children }) {
  const { hotelUid } = useHotelContext();
  return <ErrorBoundary hotelUid={hotelUid}>{children}</ErrorBoundary>;
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error) {
    const process = purchasingProcessForPath(window.location.pathname);
    if (process && this.props.hotelUid) reportPurchasingError(this.props.hotelUid, process, error, { render: true });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col justify-center items-center text-center text-gray-800 bg-canvas p-6">
          <h1 className="font-display text-3xl text-brand-950 mb-2">Something went wrong.</h1>
          <p className="mb-4">Please reload the page to try again. Review any saved command before retrying an uncertain action.</p>
          <button
            className="ht-button-primary mt-4"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
