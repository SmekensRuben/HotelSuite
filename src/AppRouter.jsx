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
          <ProtectedRoute>
            <GeneralSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products"
        element={
          <ProtectedRoute feature="products" action="view">
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
          <ProtectedRoute feature="products" action="view">
            <ProductDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products/:productId/edit"
        element={
          <ProtectedRoute feature="products" action="edit">
            <ProductEditPage />
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
      <Route
        path="/settings/users"
        element={
          <ProtectedRoute>
            <UserManagementPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/users/:userId"
        element={
          <ProtectedRoute>
            <UserDetailPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
