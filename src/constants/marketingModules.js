import { MODULE_CATALOG } from "./moduleCatalog";

// Presentation copy only. Licenses and action rights remain in the module policy.
export const MARKETING_MODULES = [
  {
    id: "procurement",
    description: "Bring purchasing and stock counts into one clear workflow.",
    features: [
      "Product and supplier catalogs",
      "Purchase orders and approvals",
      "Stock counts by location",
    ],
  },
  {
    id: "contracts",
    description: "Keep agreements, attachments and important dates together.",
    features: [
      "Central contract records",
      "Private attachments",
      "Termination dates and reminders",
    ],
  },
  {
    id: "frontoffice",
    description: "Give your front office a clearer view of daily activity.",
    features: [
      "Arrivals and reservation views",
      "Upsell audits",
      "Team performance tracking",
    ],
  },
  {
    id: "groups",
    description: "Coordinate group business and rooming lists with your team.",
    features: [
      "Group records and room blocks",
      "Guest rooming lists",
      "Versioned change requests",
    ],
  },
  {
    id: "revenue",
    description: "Make commercial decisions with your hotel data in context.",
    features: [
      "Group quote contribution analysis",
      "Demand calendar",
      "Commercial intelligence",
    ],
  },
].map((module) => ({ ...module, label: MODULE_CATALOG[module.id].label }));
