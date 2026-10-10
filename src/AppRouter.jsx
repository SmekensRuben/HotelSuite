import React, { lazy, Suspense } from "react";
const HotelOnboardingPage = lazy(() => import("./components/pages/HotelOnboardingPage.jsx"));
const HotelTeamPage = lazy(() => import("./components/pages/HotelTeamPage.jsx"));
import { Routes, Route, Navigate } from "react-router-dom";
const SubscriptionsPage = lazy(() => import("./components/pages/SubscriptionsPage.jsx"));

const LandingPage = lazy(() => import("./components/pages/LandingPage.jsx"));
const LoginPage = lazy(() => import("./components/pages/LoginPage.jsx"));
const DashboardPage = lazy(() => import("./components/pages/DashboardPage.jsx"));
import ProtectedRoute from "./components/shared/ProtectedRoute.jsx";
const GeneralSettingsPage = lazy(() => import("./components/pages/GeneralSettingsPage.jsx"));
const RoomTypesPage = lazy(() => import("./components/pages/RoomTypesPage.jsx"));
const RateCodesPage = lazy(() => import("./components/pages/RateCodesPage.jsx"));
const MarketSegmentsPage = lazy(() => import("./components/pages/MarketSegmentsPage.jsx"));
const ProductsPage = lazy(() => import("./components/pages/ProductsPage.jsx"));
const ProductCreatePage = lazy(() => import("./components/pages/ProductCreatePage.jsx"));
const ProductDetailPage = lazy(() => import("./components/pages/ProductDetailPage.jsx"));
const ProductEditPage = lazy(() => import("./components/pages/ProductEditPage.jsx"));
const SupplierProductsPage = lazy(() => import("./components/pages/SupplierProductsPage.jsx"));
const SupplierProductCreatePage = lazy(() => import("./components/pages/SupplierProductCreatePage.jsx"));
const SupplierProductDetailPage = lazy(() => import("./components/pages/SupplierProductDetailPage.jsx"));
const SupplierProductEditPage = lazy(() => import("./components/pages/SupplierProductEditPage.jsx"));
const SuppliersPage = lazy(() => import("./components/pages/SuppliersPage.jsx"));
const SupplierCreatePage = lazy(() => import("./components/pages/SupplierCreatePage.jsx"));
const SupplierDetailPage = lazy(() => import("./components/pages/SupplierDetailPage.jsx"));
const SupplierEditPage = lazy(() => import("./components/pages/SupplierEditPage.jsx"));
const SupplierOutletAccountsPage = lazy(() => import("./components/pages/SupplierOutletAccountsPage.jsx"));
const SupplierOutletAccountCreatePage = lazy(() => import("./components/pages/SupplierOutletAccountCreatePage.jsx"));
const SettingsCatalogPage = lazy(() => import("./components/pages/SettingsCatalogPage.jsx"));
const OutletSettingsPage = lazy(() => import("./components/pages/OutletSettingsPage.jsx"));
const OutletCreatePage = lazy(() => import("./components/pages/OutletCreatePage.jsx"));
const OutletDetailPage = lazy(() => import("./components/pages/OutletDetailPage.jsx"));
const OutletEditPage = lazy(() => import("./components/pages/OutletEditPage.jsx"));
const LocationSettingsPage = lazy(() => import("./components/pages/LocationSettingsPage.jsx"));
const LocationCreatePage = lazy(() => import("./components/pages/LocationCreatePage.jsx"));
const LocationDetailPage = lazy(() => import("./components/pages/LocationDetailPage.jsx"));
const LocationEditPage = lazy(() => import("./components/pages/LocationEditPage.jsx"));
const LocationStockTemplateDetailPage = lazy(() => import("./components/pages/LocationStockTemplateDetailPage.jsx"));
const UserManagementPage = lazy(() => import("./components/pages/UserManagementPage.jsx"));
const UserDetailPage = lazy(() => import("./components/pages/UserDetailPage.jsx"));
const OrdersPage = lazy(() => import("./components/pages/OrdersPage.jsx"));
const OrderCreatePage = lazy(() => import("./components/pages/OrderCreatePage.jsx"));
const ShoppingCartPage = lazy(() => import("./components/pages/ShoppingCartPage.jsx"));
const OrderDetailPage = lazy(() => import("./components/pages/OrderDetailPage.jsx"));
const OrderEditPage = lazy(() => import("./components/pages/OrderEditPage.jsx"));
const ContractsPage = lazy(() => import("./components/pages/ContractsPage.jsx"));
const ContractCreatePage = lazy(() => import("./components/pages/ContractCreatePage.jsx"));
const ContractDetailPage = lazy(() => import("./components/pages/ContractDetailPage.jsx"));
const ContractEditPage = lazy(() => import("./components/pages/ContractEditPage.jsx"));
const ContractSettingsPage = lazy(() => import("./components/pages/ContractSettingsPage.jsx"));
const FileImportSettingsPage = lazy(() => import("./components/pages/FileImportSettingsPage.jsx"));
const FileImportSettingCreatePage = lazy(() => import("./components/pages/FileImportSettingCreatePage.jsx"));
const FileImportSettingDetailPage = lazy(() => import("./components/pages/FileImportSettingDetailPage.jsx"));
const FileImportSettingEditPage = lazy(() => import("./components/pages/FileImportSettingEditPage.jsx"));
const FileImportTypesPage = lazy(() => import("./components/pages/FileImportTypesPage.jsx"));
const FileImportTypeCreatePage = lazy(() => import("./components/pages/FileImportTypeCreatePage.jsx"));
const FileImportTypeDetailPage = lazy(() => import("./components/pages/FileImportTypeDetailPage.jsx"));
const FileImportTypeEditPage = lazy(() => import("./components/pages/FileImportTypeEditPage.jsx"));
const StockCountsPage = lazy(() => import("./components/pages/StockCountsPage.jsx"));
const StockCountCreatePage = lazy(() => import("./components/pages/StockCountCreatePage.jsx"));
const StockCountDetailPage = lazy(() => import("./components/pages/StockCountDetailPage.jsx"));
const StockCountLocationPage = lazy(() => import("./components/pages/StockCountLocationPage.jsx"));
const UpsellsPage = lazy(() => import("./components/pages/UpsellsPage.jsx"));
const UpsellAuditPage = lazy(() => import("./components/pages/UpsellAuditPage.jsx"));
const UpsellCreateAuditPage = lazy(() => import("./components/pages/UpsellCreateAuditPage.jsx"));
const UpsellDetailPage = lazy(() => import("./components/pages/UpsellDetailPage.jsx"));
const UpsellSettingsPage = lazy(() => import("./components/pages/UpsellSettingsPage.jsx"));
const OperaSettingsPage = lazy(() => import("./components/pages/OperaSettingsPage.jsx"));
const GroupsPage = lazy(() => import("./components/pages/GroupsPage.jsx"));
const GroupDetailPage = lazy(() => import("./components/pages/GroupDetailPage.jsx"));
const CreateBlockPage = lazy(() => import("./components/pages/CreateBlockPage.jsx"));
const RoomingListPage = lazy(() => import("./components/pages/RoomingListPage.jsx"));
const RoomingListChangeRequestPage = lazy(() => import("./components/pages/RoomingListChangeRequestPage.jsx"));
const NotificationListsPage = lazy(() => import("./components/pages/NotificationListsPage.jsx"));
const GroupSettingsPage = lazy(() => import("./components/pages/GroupSettingsPage.jsx"));
const ArrivalsPage = lazy(() => import("./components/pages/ArrivalsPage.jsx"));
const MadeReservationsPage = lazy(() => import("./components/pages/MadeReservationsPage.jsx"));
const GroupQuotesPage = lazy(() => import("./components/pages/GroupQuotesPage.jsx"));
const GroupQuoteCreatePage = lazy(() => import("./components/pages/GroupQuoteCreatePage.jsx"));
const GroupQuoteDetailPage = lazy(() => import("./components/pages/GroupQuoteDetailPage.jsx"));
const GroupQuoteEditPage = lazy(() => import("./components/pages/GroupQuoteEditPage.jsx"));
const GroupQuoteSettingsPage = lazy(() => import("./components/pages/GroupQuoteSettingsPage.jsx"));
const DemandCalendarPage = lazy(() => import("./components/pages/DemandCalendarPage.jsx"));
const DemandCalendarEventEditorPage = lazy(() => import("./components/pages/DemandCalendarEventEditorPage.jsx"));
const DemandCalendarEventDetailPage = lazy(() => import("./components/pages/DemandCalendarEventDetailPage.jsx"));
const DemandCalendarCategoriesPage = lazy(() => import("./components/pages/DemandCalendarCategoriesPage.jsx"));
const CommercialIntelligencePage = lazy(() => import("./components/pages/CommercialIntelligencePage.jsx"));

export default function AppRouter() {
  return (
    <Suspense fallback={<div role="status" className="p-6 text-gray-600">Loading page...</div>}>
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/rooming-list/:token" element={<RoomingListPage />} />
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
          <ProtectedRoute feature="propertysettings" action="read">
            <GeneralSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route path="/settings/property" element={<ProtectedRoute feature="propertysettings" action="read"><GeneralSettingsPage /></ProtectedRoute>} />
      <Route path="/settings/property/room-types" element={<ProtectedRoute feature="propertysettings" action="read"><RoomTypesPage /></ProtectedRoute>} />
      <Route path="/settings/property/rate-codes" element={<ProtectedRoute feature="propertysettings" action="read"><RateCodesPage /></ProtectedRoute>} />
      <Route path="/settings/property/market-segments" element={<ProtectedRoute feature="propertysettings" action="read"><MarketSegmentsPage /></ProtectedRoute>} />
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
        path="/catalog/stock-counts"
        element={
          <ProtectedRoute feature="stockcounts" action="read">
            <StockCountsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/stock-counts/new"
        element={
          <ProtectedRoute feature="stockcounts" action="create">
            <StockCountCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/stock-counts/:stockCountId"
        element={
          <ProtectedRoute feature="stockcounts" action="read">
            <StockCountDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog/stock-counts/:stockCountId/locations/:locationId"
        element={
          <ProtectedRoute feature="stockcounts" action="read">
            <StockCountLocationPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/catalog"
        element={
          <ProtectedRoute feature="catalogsettings" action="read">
            <SettingsCatalogPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/outlets"
        element={
          <ProtectedRoute feature="outlets" action="read">
            <OutletSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/outlets/new"
        element={
          <ProtectedRoute feature="outlets" action="create">
            <OutletCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/outlets/:outletId"
        element={
          <ProtectedRoute feature="outlets" action="read">
            <OutletDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/outlets/:outletId/edit"
        element={
          <ProtectedRoute feature="outlets" action="update">
            <OutletEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/locations"
        element={
          <ProtectedRoute feature="locations" action="read">
            <LocationSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/locations/new"
        element={
          <ProtectedRoute feature="locations" action="create">
            <LocationCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/locations/:locationId"
        element={
          <ProtectedRoute feature="locations" action="read">
            <LocationDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/locations/:locationId/stock-templates/:templateId"
        element={
          <ProtectedRoute feature="locations" action="read">
            <LocationStockTemplateDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/locations/:locationId/edit"
        element={
          <ProtectedRoute feature="locations" action="update">
            <LocationEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import"
        element={
          <ProtectedRoute feature="imports" action="read">
            <FileImportSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import/new"
        element={
          <ProtectedRoute feature="imports" action="create">
            <FileImportSettingCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import/:fileImportSettingId"
        element={
          <ProtectedRoute feature="imports" action="read">
            <FileImportSettingDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import/:fileImportSettingId/edit"
        element={
          <ProtectedRoute feature="imports" action="update">
            <FileImportSettingEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import-types"
        element={
          <ProtectedRoute feature="imports" action="read">
            <FileImportTypesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import-types/new"
        element={
          <ProtectedRoute feature="imports" action="create">
            <FileImportTypeCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import-types/:fileImportTypeId"
        element={
          <ProtectedRoute feature="imports" action="read">
            <FileImportTypeDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/file-import-types/:fileImportTypeId/edit"
        element={
          <ProtectedRoute feature="imports" action="update">
            <FileImportTypeEditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/opera"
        element={
          <ProtectedRoute feature="integrations" action="read">
            <OperaSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/front-office/arrivals"
        element={<ProtectedRoute feature="reservations" action="read"><ArrivalsPage /></ProtectedRoute>}
      />
      <Route
        path="/front-office/made-reservations"
        element={<ProtectedRoute feature="reservations" action="read"><MadeReservationsPage /></ProtectedRoute>}
      />
      <Route
        path="/revenue/group-quotes"
        element={<ProtectedRoute feature="groupquotes" action="read"><GroupQuotesPage /></ProtectedRoute>}
      />
      <Route path="/revenue/commercial-intelligence" element={<ProtectedRoute feature="commercialintelligence" action="read"><CommercialIntelligencePage /></ProtectedRoute>} />
      <Route
        path="/revenue/group-quotes/new"
        element={<ProtectedRoute feature="groupquotes" action="create"><GroupQuoteCreatePage /></ProtectedRoute>}
      />
      <Route
        path="/revenue/group-quotes/settings"
        element={<ProtectedRoute feature="groupquotes" action="update"><GroupQuoteSettingsPage /></ProtectedRoute>}
      />
      <Route
        path="/revenue/group-quotes/:quoteId"
        element={<ProtectedRoute feature="groupquotes" action="read"><GroupQuoteDetailPage /></ProtectedRoute>}
      />
      <Route
        path="/revenue/group-quotes/:quoteId/edit"
        element={<ProtectedRoute feature="groupquotes" action="update"><GroupQuoteEditPage /></ProtectedRoute>}
      />
      <Route
        path="/front-office/upselling"
        element={
          <ProtectedRoute feature="auditUpsells" action="read">
            <UpsellsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/front-office/upselling/audit"
        element={
          <ProtectedRoute feature="auditUpsells" action="settings">
            <UpsellAuditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/front-office/upselling/audit/create"
        element={
          <ProtectedRoute feature="auditUpsells" action="settings">
            <UpsellCreateAuditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/front-office/upselling/:date/:auditUpsellId"
        element={
          <ProtectedRoute anyOf={[{ feature: "auditUpsells", action: "read" }, { feature: "auditUpsells", action: "settings" }]}>
            <UpsellDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/front-office/upselling/settings"
        element={
          <ProtectedRoute feature="auditUpsells" action="settings">
            <UpsellSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/notification-lists"
        element={<ProtectedRoute feature="notifications" action="read"><NotificationListsPage /></ProtectedRoute>}
      />
      <Route
        path="/me/groups"
        element={
          <ProtectedRoute feature="groups" action="read">
            <GroupsPage />
          </ProtectedRoute>
        }
      />
      <Route path="/me/demand-calendar" element={<ProtectedRoute feature="demandcalendar" action="read"><DemandCalendarPage /></ProtectedRoute>} />
      <Route path="/me/demand-calendar/new" element={<ProtectedRoute feature="demandcalendar" action="create"><DemandCalendarEventEditorPage /></ProtectedRoute>} />
      <Route path="/me/demand-calendar/categories" element={<ProtectedRoute feature="demandcalendar" action="update"><DemandCalendarCategoriesPage /></ProtectedRoute>} />
      <Route path="/me/demand-calendar/:eventId" element={<ProtectedRoute feature="demandcalendar" action="read"><DemandCalendarEventDetailPage /></ProtectedRoute>} />
      <Route path="/me/demand-calendar/:eventId/edit" element={<ProtectedRoute feature="demandcalendar" action="update"><DemandCalendarEventEditorPage /></ProtectedRoute>} />
      <Route
        path="/me/groups/new"
        element={
          <ProtectedRoute feature="groups" action="create">
            <CreateBlockPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/me/groups/settings"
        element={<ProtectedRoute feature="groups" action="update"><GroupSettingsPage /></ProtectedRoute>}
      />
      <Route
        path="/me/groups/:groupId"
        element={
          <ProtectedRoute feature="groups" action="read">
            <GroupDetailPage />
          </ProtectedRoute>
        }
      />
      <Route path="/me/groups/:groupId/rooming-list-change-request/:requestId" element={<ProtectedRoute feature="roominglists" action="approve"><RoomingListChangeRequestPage /></ProtectedRoute>} />
      <Route
        path="/me/groups/:groupId/edit"
        element={
          <ProtectedRoute feature="groups" action="update">
            <CreateBlockPage mode="edit" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/hotels"
        element={<ProtectedRoute platformOnly><HotelOnboardingPage /></ProtectedRoute>}
      />
      <Route
        path="/settings/subscriptions"
        element={<ProtectedRoute platformOnly><SubscriptionsPage /></ProtectedRoute>}
      />
      <Route
        path="/settings/users"
        element={
          <ProtectedRoute platformOnly feature="users" action="read">
            <UserManagementPage />
          </ProtectedRoute>
        }
      />
      <Route path="/settings/team" element={<ProtectedRoute hotelAdminOnly feature="users" action="read"><HotelTeamPage /></ProtectedRoute>} />
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
          <ProtectedRoute feature="contracts" action="settings">
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
          <ProtectedRoute platformOnly feature="users" action="update">
            <UserDetailPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
    </Suspense>
  );
}
