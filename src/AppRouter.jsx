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
import SupplierOutletAccountsPage from "./components/pages/SupplierOutletAccountsPage.jsx";
import SupplierOutletAccountCreatePage from "./components/pages/SupplierOutletAccountCreatePage.jsx";
import SettingsCatalogPage from "./components/pages/SettingsCatalogPage.jsx";
import OutletSettingsPage from "./components/pages/OutletSettingsPage.jsx";
import OutletCreatePage from "./components/pages/OutletCreatePage.jsx";
import OutletDetailPage from "./components/pages/OutletDetailPage.jsx";
import OutletEditPage from "./components/pages/OutletEditPage.jsx";
import UserManagementPage from "./components/pages/UserManagementPage.jsx";
import UserDetailPage from "./components/pages/UserDetailPage.jsx";
import OrdersPage from "./components/pages/OrdersPage.jsx";
import OrderCreatePage from "./components/pages/OrderCreatePage.jsx";
import ShoppingCartPage from "./components/pages/ShoppingCartPage.jsx";
import OrderDetailPage from "./components/pages/OrderDetailPage.jsx";
import OrderEditPage from "./components/pages/OrderEditPage.jsx";
import ContractsPage from "./components/pages/ContractsPage.jsx";
import ContractCreatePage from "./components/pages/ContractCreatePage.jsx";
import ContractDetailPage from "./components/pages/ContractDetailPage.jsx";
import ContractEditPage from "./components/pages/ContractEditPage.jsx";
import ContractSettingsPage from "./components/pages/ContractSettingsPage.jsx";
import FileImportSettingsPage from "./components/pages/FileImportSettingsPage.jsx";
import FileImportSettingCreatePage from "./components/pages/FileImportSettingCreatePage.jsx";
import FileImportSettingDetailPage from "./components/pages/FileImportSettingDetailPage.jsx";
import FileImportSettingEditPage from "./components/pages/FileImportSettingEditPage.jsx";
import FileImportTypesPage from "./components/pages/FileImportTypesPage.jsx";
import FileImportTypeCreatePage from "./components/pages/FileImportTypeCreatePage.jsx";
import FileImportTypeDetailPage from "./components/pages/FileImportTypeDetailPage.jsx";
import FileImportTypeEditPage from "./components/pages/FileImportTypeEditPage.jsx";
import PickUpPage from "./components/pages/PickUpPage.jsx";

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
        path="/catalog/suppliers/:supplierId/outlet-accounts"
        element={
          <ProtectedRoute feature="suppliers" action="read">
            <SupplierOutletAccountsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/suppliers/:supplierId/outlet-accounts/new"
        element={
          <ProtectedRoute feature="suppliers" action="update">
            <SupplierOutletAccountCreatePage />
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
        path="/settings/outlets"
        element={
          <ProtectedRoute feature="settings" action="read">
            <OutletSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/outlets/new"
        element={
          <ProtectedRoute feature="settings" action="create">
            <OutletCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/outlets/:outletId"
        element={
          <ProtectedRoute feature="settings" action="read">
            <OutletDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/outlets/:outletId/edit"
        element={
          <ProtectedRoute feature="settings" action="update">
            <OutletEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/revenue-management/pick-up"
        element={
          <ProtectedRoute>
            <PickUpPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import"
        element={
          <ProtectedRoute feature="settings" action="read">
            <FileImportSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import/new"
        element={
          <ProtectedRoute feature="settings" action="create">
            <FileImportSettingCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import/:fileImportSettingId"
        element={
          <ProtectedRoute feature="settings" action="read">
            <FileImportSettingDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import/:fileImportSettingId/edit"
        element={
          <ProtectedRoute feature="settings" action="update">
            <FileImportSettingEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import-types"
        element={
          <ProtectedRoute feature="settings" action="read">
            <FileImportTypesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import-types/new"
        element={
          <ProtectedRoute feature="settings" action="create">
            <FileImportTypeCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import-types/:fileImportTypeId"
        element={
          <ProtectedRoute feature="settings" action="read">
            <FileImportTypeDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import-types/:fileImportTypeId/edit"
        element={
          <ProtectedRoute feature="settings" action="update">
            <FileImportTypeEditPage />
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
        path="/orders"
        element={
          <ProtectedRoute feature="orders" action="read">
            <OrdersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/orders/new"
        element={
          <ProtectedRoute feature="orders" action="create">
            <OrderCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/orders/cart/:cartId"
        element={
          <ProtectedRoute feature="orders" action="read">
            <ShoppingCartPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/orders/:orderId"
        element={
          <ProtectedRoute feature="orders" action="read">
            <OrderDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/orders/:orderId/edit"
        element={
          <ProtectedRoute feature="orders" action="update">
            <OrderEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/contracts"
        element={
          <ProtectedRoute feature="contracts" action="read">
            <ContractsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/contracts/settings"
        element={
          <ProtectedRoute feature="settings" action="read">
            <ContractSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/contracts/new"
        element={
          <ProtectedRoute feature="contracts" action="create">
            <ContractCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/contracts/:contractId"
        element={
          <ProtectedRoute feature="contracts" action="read">
            <ContractDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/contracts/:contractId/edit"
        element={
          <ProtectedRoute feature="contracts" action="update">
            <ContractEditPage />
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
