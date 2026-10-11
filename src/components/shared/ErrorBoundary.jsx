import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("❌ Error caught in boundary:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col justify-center items-center text-center text-gray-800 bg-canvas p-6">
          <h1 className="font-display text-3xl text-brand-950 mb-2">Something went wrong.</h1>
          <p className="mb-4">{this.state.error?.message || "Please reload the page to try again."}</p>
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
