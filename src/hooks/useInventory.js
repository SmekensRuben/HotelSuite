import { Routes, Route, Navigate, useLocation } from "react-router-dom";

// Directe imports van pagina's
import LandingPage from "./components/pages/LandingPage.jsx";
import LoginPage from "./components/pages/LoginPage.jsx";

import ProtectedRoute from "./components/shared/ProtectedRoute.jsx";
import IngredientsPage from "./components/pages/IngredientsPage.jsx";
import HotelDashboard from "./components/pages/HotelDashboard.jsx";
import SettingsPage from "./components/pages/SettingsPage.jsx";
import OrdersPage from "./components/pages/OrdersPage.jsx";
import NewOrderPage from "./components/pages/NewOrderPage.jsx";
import EditOrderPage from "./components/pages/EditOrderPage.jsx";

export default function AppRouter() {
  const location = useLocation();

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <HotelDashboard />
          </ProtectedRoute>
        }
      />

      <Route
        path="/ingredients"
        element={
          <ProtectedRoute>
            <IngredientsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/orders"
        element={
          <ProtectedRoute>
            <OrdersPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/neworder"
        element={
          <ProtectedRoute>
            <NewOrderPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/orders/:orderId/edit"
        element={
          <ProtectedRoute>
            <EditOrderPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      {/* Fallback: alle onbekende routes redirecten naar login */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
