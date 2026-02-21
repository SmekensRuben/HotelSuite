import { Routes, Route, Navigate } from "react-router-dom";

import LandingPage from "./components/pages/LandingPage.jsx";
import LoginPage from "./components/pages/LoginPage.jsx";
import DashboardPage from "./components/pages/DashboardPage.jsx";
import ProtectedRoute from "./components/shared/ProtectedRoute.jsx";
import GeneralSettingsPage from "./components/pages/GeneralSettingsPage.jsx";
import ProductsPage from "./components/pages/ProductsPage.jsx";
import ProductCreatePage from "./components/pages/ProductCreatePage.jsx";
import ProductDetailPage from "./components/pages/ProductDetailPage.jsx";
import ProductEditPage from "./components/pages/ProductEditPage.jsx";
import SettingsCatalogPage from "./components/pages/SettingsCatalogPage.jsx";
import UserManagementPage from "./components/pages/UserManagementPage.jsx";
import UserDetailPage from "./components/pages/UserDetailPage.jsx";

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
          <ProtectedRoute feature="settings" action="read">
            <GeneralSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products"
        element={
          <ProtectedRoute feature="products" action="read">
            <ProductsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products/new"
        element={
          <ProtectedRoute feature="products" action="create">
            <ProductCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products/:productId"
        element={
          <ProtectedRoute feature="products" action="read">
            <ProductDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products/:productId/edit"
        element={
          <ProtectedRoute feature="products" action="update">
            <ProductEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/catalog"
        element={
          <ProtectedRoute feature="settings" action="read">
            <SettingsCatalogPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/users"
        element={
          <ProtectedRoute feature="users" action="read">
            <UserManagementPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/users/:userId"
        element={
          <ProtectedRoute feature="users" action="update">
            <UserDetailPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
