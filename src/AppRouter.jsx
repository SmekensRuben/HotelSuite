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
import SupplierProductsPage from "./components/pages/SupplierProductsPage.jsx";
import SupplierProductCreatePage from "./components/pages/SupplierProductCreatePage.jsx";
import SupplierProductDetailPage from "./components/pages/SupplierProductDetailPage.jsx";
import SupplierProductEditPage from "./components/pages/SupplierProductEditPage.jsx";
import SuppliersPage from "./components/pages/SuppliersPage.jsx";
import SupplierCreatePage from "./components/pages/SupplierCreatePage.jsx";
import SupplierDetailPage from "./components/pages/SupplierDetailPage.jsx";
import SupplierEditPage from "./components/pages/SupplierEditPage.jsx";
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
          <ProtectedRoute feature="catalogproducts" action="read">
            <ProductsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products/new"
        element={
          <ProtectedRoute feature="catalogproducts" action="create">
            <ProductCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products/:productId"
        element={
          <ProtectedRoute feature="catalogproducts" action="read">
            <ProductDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/products/:productId/edit"
        element={
          <ProtectedRoute feature="catalogproducts" action="update">
            <ProductEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/supplier-products"
        element={
          <ProtectedRoute feature="supplierproducts" action="read">
            <SupplierProductsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/supplier-products/new"
        element={
          <ProtectedRoute feature="supplierproducts" action="create">
            <SupplierProductCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/supplier-products/:productId"
        element={
          <ProtectedRoute feature="supplierproducts" action="read">
            <SupplierProductDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/supplier-products/:productId/edit"
        element={
          <ProtectedRoute feature="supplierproducts" action="update">
            <SupplierProductEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/suppliers"
        element={
          <ProtectedRoute feature="suppliers" action="read">
            <SuppliersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/suppliers/new"
        element={
          <ProtectedRoute feature="suppliers" action="create">
            <SupplierCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/suppliers/:supplierId"
        element={
          <ProtectedRoute feature="suppliers" action="read">
            <SupplierDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/suppliers/:supplierId/edit"
        element={
          <ProtectedRoute feature="suppliers" action="update">
            <SupplierEditPage />
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
