const { syncCatalogProductsToMeili, syncSupplierProductsToMeili, syncFileImportSettingsIndex, syncFileImportTypesIndex } = require("./src/meili");
const { handleResendEmailReceivedWebhook } = require("./src/webhook");
const { processMailQueue } = require("./src/mailQueue");
const { sendContractCancellationReminders, runContractCancellationRemindersNow } = require("./src/contracts");
const { sendOrderApprovalEmailToApprovers } = require("./src/approvals");
const { sendOrderedSupplierOrder } = require("./src/sftpDispatch");
const { processImportedFileToFirestore } = require("./src/fileImportTypes");
const { sendScheduledOccupancyMail, runScheduledOccupancyMailNow } = require("./src/occupancyMail");
const { sendScheduledBlockPickupReport } = require("./src/blockPickupMail");
const { processScheduledAuditUpsells } = require("./src/auditUpsell");
const { linkLatestArrivalDescriptions, listArrivalDates } = require("./src/arrivals");
const { processNightlyGuestIntelligence, cleanupExpiredGuestIntelligence, resumeGuestIntelligenceRuns } = require("./src/guestIntelligence");
const { sendScheduledGuestIntelligenceMail } = require("./src/guestIntelligenceMail");
const { rebuildStayPatternModelCallable } = require("./src/stayPatternModel");
const { updateUserAccess } = require("./src/userAccess");
const { setHotelSubscription, listHotelSubscriptions } = require("./src/subscriptions");
const { searchHotelProducts } = require("./src/productSearch");

exports.syncCatalogProductsToMeili = syncCatalogProductsToMeili;
exports.syncSupplierProductsToMeili = syncSupplierProductsToMeili;
exports.syncFileImportSettingsIndex = syncFileImportSettingsIndex;
exports.syncFileImportTypesIndex = syncFileImportTypesIndex;
exports.handleResendEmailReceivedWebhook = handleResendEmailReceivedWebhook;
exports.processMailQueue = processMailQueue;
exports.sendContractCancellationReminders = sendContractCancellationReminders;
exports.runContractCancellationRemindersNow = runContractCancellationRemindersNow;
exports.sendOrderApprovalEmailToApprovers = sendOrderApprovalEmailToApprovers;
exports.sendOrderedSupplierOrder = sendOrderedSupplierOrder;

exports.processImportedFileToFirestore = processImportedFileToFirestore;

exports.sendScheduledOccupancyMail = sendScheduledOccupancyMail;
exports.runScheduledOccupancyMailNow = runScheduledOccupancyMailNow;

exports.sendScheduledBlockPickupReport = sendScheduledBlockPickupReport;
exports.processScheduledAuditUpsells = processScheduledAuditUpsells;
exports.listArrivalDates = listArrivalDates;
exports.linkLatestArrivalDescriptions = linkLatestArrivalDescriptions;
exports.processNightlyGuestIntelligence = processNightlyGuestIntelligence;
exports.cleanupExpiredGuestIntelligence = cleanupExpiredGuestIntelligence;
exports.resumeGuestIntelligenceRuns = resumeGuestIntelligenceRuns;
exports.sendScheduledGuestIntelligenceMail = sendScheduledGuestIntelligenceMail;
exports.rebuildStayPatternModel = rebuildStayPatternModelCallable;
exports.updateUserAccess = updateUserAccess;
const hotelTeam = require("./src/hotelTeam");
for (const name of ["listHotelTeam", "updateHotelMember", "removeHotelMember"]) exports[name] = hotelTeam[name];
exports.setHotelSubscription = setHotelSubscription;
exports.listHotelSubscriptions = listHotelSubscriptions;
exports.searchHotelProducts = searchHotelProducts;
const products = require("./src/products");
for (const name of ["mutateHotelCatalogProduct", "mutateHotelSupplierProduct", "importHotelProducts"]) exports[name] = products[name];
const supplierProductImages = require("./src/supplierProductImages");
for (const name of ["supplierProductImage", "processSupplierProductImage"]) exports[name] = supplierProductImages[name];

// Protected SaaS onboarding and procurement boundaries.
const onboarding = require("./src/onboarding");
exports.getHotelSetupReadiness = require("./src/hotelSetup").getHotelSetupReadiness;
const suppliers = require("./src/suppliers");
const orders = require("./src/orders");
for (const name of ["createHotel", "inviteHotelUser", "listHotelUsers", "getHotelOnboardingStatus"]) exports[name] = onboarding[name];
for (const name of ["listSuppliers", "getSupplierConnection", "saveSupplier", "deleteSupplier", "migrateSupplierCredentials"]) exports[name] = suppliers[name];
for (const name of ["createOrdersFromCart", "updateHotelOrder", "deleteHotelOrder", "confirmHotelOrder", "setHotelOutletApprovers", "saveSupplierOutletAccount"]) exports[name] = orders[name];
exports.mutateHotelShoppingCart = require("./src/shoppingCarts").mutateHotelShoppingCart;
exports.reviewHotelOrderDelivery = require("./src/deliveryRecovery").reviewHotelOrderDelivery;
const receiving = require("./src/orderReceiving");
for (const name of ["recordHotelOrderReceipt", "reverseHotelOrderReceipt", "finalizeHotelOrderReceiving", "getHotelOrderReceiving"]) exports[name] = receiving[name];
const supplierConfirmations = require("./src/supplierConfirmations");
for (const name of ["getHotelSupplierConfirmations", "recordHotelSupplierConfirmation", "reviewHotelSupplierConfirmation"]) exports[name] = supplierConfirmations[name];
const stockCounts = require("./src/stockCounts");
for (const name of ["createHotelStockCount", "mutateHotelStockCount", "listHotelStockCountSources"]) exports[name] = stockCounts[name];
exports.mutateHotelStockTemplate = require("./src/stockTemplates").mutateHotelStockTemplate;
exports.getHotelStockTemplateDisplay = require("./src/stockTemplates").getHotelStockTemplateDisplay;
exports.getHotelStockCountPackageOptions = require("./src/stockCountPackages").getHotelStockCountPackageOptions;
exports.getHotelInventoryCostProposal = require("./src/inventoryCostProposals").getHotelInventoryCostProposal;
exports.getHotelSupplierPriceInsights = require("./src/supplierPriceInsights").getHotelSupplierPriceInsights;
const inventoryAdjustments = require("./src/inventoryAdjustments");
for (const name of ["recordHotelInventoryAdjustment", "reverseHotelInventoryAdjustment", "listHotelInventoryAdjustments", "listHotelInventoryAdjustmentChoices"]) exports[name] = inventoryAdjustments[name];
exports.mutateHotelProcurementResource = require("./src/procurementResources").mutateHotelProcurementResource;
const inventoryReports = require("./src/inventoryReports");
for (const name of ["listHotelInventoryLocations", "listHotelInventoryCheckpoints", "getHotelInventoryPeriod"]) exports[name] = inventoryReports[name];
exports.getHotelUserDisplayName = require("./src/staffDisplay").getHotelUserDisplayName;
exports.getHotelUserDisplayNames = require("./src/staffDisplay").getHotelUserDisplayNames;

const contractFiles = require("./src/contractFiles");
for (const name of ["listHotelContracts", "listContractFollowers", "saveHotelContract", "contractDocument"]) exports[name] = contractFiles[name];

const roomingLists = require("./src/roomingLists");
for (const name of ["getRoomingList", "createRoomingList", "mutateRoomingList", "reviewRoomingList", "setRoomingListAccess"]) exports[name] = roomingLists[name];

// Platform metadata and diagnostics do not require an operational hotel assignment.
for (const module of ["platformConsole", "platformMonitoring", "platformSupport", "platformUsers", "supplierAiPlatform"]) {
  const boundaries = require(`./src/${module}`);
  for (const [name, value] of Object.entries(boundaries)) {
    if (value?.__endpoint) exports[name] = value;
  }
}
exports.syncPlatformImportTelemetry = require("./src/importTelemetry").syncPlatformImportTelemetry;

// Explicit, platform-only fictional data for the reserved test hotel.
exports.manageHotelDemoData = require("./src/demoData").manageHotelDemoData;

// Private supplier-import jobs and explicit human review use separate boundaries.
for (const module of ["supplierAiImports", "supplierAiProposal", "supplierImportMappings", "supplierAiReview"]) {
  for (const [name, value] of Object.entries(require(`./src/${module}`))) {
    if (value?.__endpoint) exports[name] = value;
  }
}
