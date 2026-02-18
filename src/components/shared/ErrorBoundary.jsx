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
        <div className="min-h-screen flex flex-col justify-center items-center text-center text-red-700 bg-gray-100 p-6">
          <h1 className="text-2xl font-bold mb-2">Er is iets misgelopen.</h1>
          <p className="mb-4">{this.state.error?.message || "Onbekende fout"}</p>
          <button
            className="mt-4 bg-[#b41f1f] text-white px-4 py-2 rounded"
            onClick={() => window.location.reload()}
          >
            Herlaad pagina
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
