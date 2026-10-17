import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import ErrorBoundary, { PurchasingErrorBoundary } from "components/shared/ErrorBoundary";
import { HotelProvider } from "./contexts/HotelContext"; // ✅ import
import './i18n';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <HotelProvider>
          <PurchasingErrorBoundary><App /></PurchasingErrorBoundary>
        </HotelProvider>
      </ErrorBoundary>
    </BrowserRouter>         
  </React.StrictMode>
);

