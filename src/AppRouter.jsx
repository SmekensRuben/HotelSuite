import { Routes, Route, Navigate } from "react-router-dom";

import LandingPage from "./components/pages/LandingPage.jsx";
import LoginPage from "./components/pages/LoginPage.jsx";
import DashboardPage from "./components/pages/DashboardPage.jsx";
import ProtectedRoute from "./components/shared/ProtectedRoute.jsx";
import GeneralSettingsPage from "./components/pages/GeneralSettingsPage.jsx";
import SettingsCatalogPage from "./components/pages/SettingsCatalogPage.jsx";

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/general"
        element={
          <ProtectedRoute>
            <GeneralSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/catalog"
        element={
          <ProtectedRoute>
            <SettingsCatalogPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
