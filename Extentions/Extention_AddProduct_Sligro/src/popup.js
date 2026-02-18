import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  addDoc
} from "firebase/firestore";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBUqtUVov_JcgJ5CvA4tNvF3JMar7FbaLU",
  authDomain: "test-breakfast.firebaseapp.com",
  projectId: "test-breakfast"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const cleanNameWithBrand = (nameValue, brandValue) => {
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  if (!name) return "";
  const brand = typeof brandValue === "string" ? brandValue.trim() : "";
  if (!brand) return name;

  const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedBrand = normalize(brand);
  const matchesBrand = (value) => normalize(value) === normalizedBrand;

  const separators = ["|", "-", "–", "—", ":", ";", "/"];
  for (const separator of separators) {
    const idx = name.indexOf(separator);
    if (idx > 0) {
      const possibleBrand = name.slice(0, idx).trim();
      if (possibleBrand && matchesBrand(possibleBrand)) {
        const remainder = name.slice(idx + 1).trim();
        if (remainder) {
          return remainder;
        }
      }
    }
  }

  const lineParts = name.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean);
  if (lineParts.length > 1 && matchesBrand(lineParts[0])) {
    const remainder = lineParts.slice(1).join(" ").trim();
    if (remainder) {
      return remainder;
    }
  }

  const words = name.split(/\s+/);
  const brandWords = brand.split(/\s+/);
  if (brandWords.length && words.length > brandWords.length) {
    const firstWords = words.slice(0, brandWords.length).join(" ");
    if (matchesBrand(firstWords)) {
      return words.slice(brandWords.length).join(" ").trim();
    }
  }

  if (matchesBrand(name)) {
    return "";
  }

  return name;
};

const SHOP_OPTIONS = {
  sligro: {
    label: "Sligro",
    hosts: ["sligro.nl", "sligro.be"],
    scrape: () => {
      const cleanNameWithBrand = (nameValue, brandValue) => {
        const name = typeof nameValue === "string" ? nameValue.trim() : "";
        if (!name) return "";
        const brand = typeof brandValue === "string" ? brandValue.trim() : "";
        if (!brand) return name;

        const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const normalizedBrand = normalize(brand);
        const matchesBrand = (value) => normalize(value) === normalizedBrand;

        const separators = ["|", "-", "–", "—", ":", ";", "/"];
        for (const separator of separators) {
          const idx = name.indexOf(separator);
          if (idx > 0) {
            const possibleBrand = name.slice(0, idx).trim();
            if (possibleBrand && matchesBrand(possibleBrand)) {
              const remainder = name.slice(idx + 1).trim();
              if (remainder) {
                return remainder;
              }
            }
          }
        }

        const lineParts = name.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean);
        if (lineParts.length > 1 && matchesBrand(lineParts[0])) {
          const remainder = lineParts.slice(1).join(" ").trim();
          if (remainder) {
            return remainder;
          }
        }

        const words = name.split(/\s+/);
        const brandWords = brand.split(/\s+/);
        if (brandWords.length && words.length > brandWords.length) {
          const firstWords = words.slice(0, brandWords.length).join(" ");
          if (matchesBrand(firstWords)) {
            return words.slice(brandWords.length).join(" ").trim();
          }
        }

        if (matchesBrand(name)) {
          return "";
        }

        return name;
      };

      const parsePrice = (value) => {
        if (!value) return null;
    const cleaned = value
      .toString()
      .replace(/[^\d,.-]/g, "")
      .replace(/\.(?=\d{3}(?:\D|$))/g, "")
      .replace(",", ".");
    const price = parseFloat(cleaned);
    return Number.isFinite(price) ? price : null;
  };

  const normaliseArticle = (value) => {
    if (!value && value !== 0) return "";
    return value
      .toString()
      .replace(/Art\.?nr\.?/i, "")
      .replace(/[^0-9A-Za-z-]/g, "")
      .trim();
  };

    const toAbsoluteUrl = (value) => {
      if (!value) return "";
      try {
        return new URL(value, window.location.origin).href;
      } catch (err) {
        return "";
      }
    };

    const extractImageSrc = (img) => {
      if (!img) return "";
      const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-lazy") || img.getAttribute("data-original");
      const srcset = img.getAttribute("srcset");
      const firstSrcset = srcset ? srcset.split(",")[0]?.trim().split(/\s+/)[0] : "";
      const raw = dataSrc || img.getAttribute("src") || firstSrcset || "";
      return toAbsoluteUrl(raw);
    };

    const getImageFromElement = (element) => {
      if (!element) return "";
      const img = element.querySelector("img");
      if (img) {
        const url = extractImageSrc(img);
        if (url) return url;
      }
      const source = element.querySelector("picture source");
      if (source) {
        const srcset = source.getAttribute("srcset");
        if (srcset) {
          const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
          const url = toAbsoluteUrl(first);
          if (url) return url;
        }
      }
      return "";
    };

    const getBrandFromElement = (element) => {
      if (!element) return "";
      const brandSelectors = [
        ".cmp-producttile__subtitle",
        ".cmp-producttile__brand",
        ".cmp-product__brand",
        ".product-brand",
        "[data-brand]",
        ".cmp-productdetail__brand",
        ".cmp-productdetail__manufacturer",
        ".cmp-listdetail__table-brandname"
      ];
      for (const selector of brandSelectors) {
        const node = element.querySelector(selector);
        if (!node) continue;
        const attrBrand = node.getAttribute?.("data-brand");
        if (attrBrand && attrBrand.trim()) {
          return attrBrand.trim();
        }
        const text = node.textContent?.trim();
        if (text) {
          return text;
        }
      }
      return "";
    };

    const resultsMap = new Map();
    const addResult = (articleNumber, price, name, extra = {}) => {
      const normalized = normaliseArticle(articleNumber);
      if (!normalized) return;
      const existing = resultsMap.get(normalized);
      const displayArticle = articleNumber == null ? "" : String(articleNumber).trim();
      const brand = typeof extra.brand === "string" ? extra.brand.trim() : "";
      const imageUrl = typeof extra.imageUrl === "string" ? toAbsoluteUrl(extra.imageUrl) : "";
      const cleanedName = cleanNameWithBrand(name, brand);
      if (!existing) {
        resultsMap.set(normalized, {
          articleNumber: displayArticle || normalized,
          price: Number.isFinite(price) ? price : null,
          name: cleanedName,
          brand,
          imageUrl
        });
        return;
      }
      if ((existing.price === null || !Number.isFinite(existing.price)) && Number.isFinite(price)) {
        existing.price = price;
      }
      if (!existing.brand && brand) {
        existing.brand = brand;
      }
      const effectiveBrand = existing.brand || brand;
      if (existing.name) {
        existing.name = cleanNameWithBrand(existing.name, effectiveBrand);
      }
      const candidateName = cleanNameWithBrand(name, effectiveBrand);
      if (!existing.name && candidateName) {
        existing.name = candidateName;
      }
      if (!existing.imageUrl && imageUrl) {
        existing.imageUrl = imageUrl;
      }
    };

  // Product detail view
  const detailArticle = document.querySelector(
    ".cmp-productdetail__subinfo--articlenr span:last-child"
  )?.textContent?.trim();
  if (detailArticle) {
    const priceNodes = Array.from(document.querySelectorAll(".cmp-price__price"));
    const rawPrice = priceNodes[priceNodes.length - 1]?.textContent || "";
    const price = parsePrice(rawPrice);
    const name = document.querySelector(".cmp-productdetail__title")?.textContent?.trim();
    const detailBrand =
      document.querySelector(".cmp-productdetail__brand")?.textContent?.trim() ||
      document.querySelector(".cmp-productdetail__manufacturer")?.textContent?.trim() ||
      document.querySelector(".cmp-productdetail__subtitle")?.textContent?.trim() ||
      "";
    const detailImage = (() => {
      const img = document.querySelector(
        ".cmp-productdetail__image img, .cmp-productdetail__gallery img, .cmp-productdetail__carousel img"
      );
      return extractImageSrc(img);
    })();
    addResult(detailArticle, price, name, { brand: detailBrand, imageUrl: detailImage });
  }

  const candidateSelectors = [
    "[data-articlenumber]",
    "[data-article-number]",
    "[data-article]",
    "[data-item-number]",
    ".cmp-producttile",
    ".cmp-productlist__item",
    ".cmp-product",
    ".product-tile",
    "article[data-articlenumber]",
    "article[data-article-number]",
    "tr[data-articlenumber]",
    "tr[data-article-number]"
  ];

  const candidateElements = new Set();
  candidateSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => candidateElements.add(el));
  });

  const getNameCandidates = (element) => {
    const nameSelectors = [
      ".cmp-producttile__title",
      ".cmp-product__title",
      ".cmp-product__name",
      ".product-title",
      ".product-card__title",
      "h3",
      "h2"
    ];
    for (const selector of nameSelectors) {
      const node = element.querySelector(selector);
      if (node?.textContent?.trim()) {
        return node.textContent.trim();
      }
    }
    return "";
  };

  candidateElements.forEach((element) => {
    const articleCandidates = [
      element.getAttribute("data-articlenumber"),
      element.getAttribute("data-article-number"),
      element.getAttribute("data-article"),
      element.getAttribute("data-item-number"),
      element.querySelector("[data-articlenumber]")?.getAttribute("data-articlenumber"),
      element.querySelector("[data-article-number]")?.getAttribute("data-article-number"),
      element.querySelector("[data-article]")?.getAttribute("data-article"),
      element.querySelector(".cmp-producttile__articlenumber")?.textContent,
      element.querySelector(".cmp-product__article")?.textContent,
      element.querySelector(".product-article-number")?.textContent
    ].filter(Boolean);

    let article = "";
    if (articleCandidates.length) {
      article = articleCandidates[0];
    } else {
      const text = element.textContent || "";
      const match = text.match(/Art\.?\s*nr\.?\s*([\w-]+)/i);
      if (match) {
        article = match[1];
      }
    }

    const priceCandidates = [
      element.getAttribute("data-price"),
      element.querySelector(".cmp-price__price")?.textContent,
      element.querySelector(".cmp-producttile__price")?.textContent,
      element.querySelector(".product-price")?.textContent,
      element.querySelector(".price")?.textContent,
      element.querySelector("[class*='price'] span")?.textContent
    ].filter(Boolean);

    let price = null;
    for (const raw of priceCandidates) {
      price = parsePrice(raw);
      if (Number.isFinite(price)) break;
    }

    const name = getNameCandidates(element);
    const brand = getBrandFromElement(element);
    const imageUrl = getImageFromElement(element);
    addResult(article, price, name, { brand, imageUrl });
  });

  // ✅ EXTRA: ondersteuning voor lijstweergave (tabellen)
  document.querySelectorAll("table tr").forEach((row) => {
    const cells = Array.from(row.querySelectorAll("td"));
    if (cells.length < 2) return;

    const verpakkingTxt = (cells[1].textContent || "").trim();
    const match = verpakkingTxt.match(/^\s*(\d{4,8})\b/);
    const art = match ? match[1] : "";
    if (!art) return;

    const name = (cells[0].textContent || "").trim();

    const priceCell = cells.find(td =>
      /\€|\bprice\b/i.test(td.textContent) ||
      td.querySelector(".price, .cmp-price__price")
    );
    const rawPrice = priceCell ? priceCell.textContent : "";
    const price = parsePrice(rawPrice);

    const brand = getBrandFromElement(row);
    const imageUrl = getImageFromElement(row);
    addResult(art, price, name, { brand, imageUrl });
  });

  document.querySelectorAll(".cmp-listedetail__table tr").forEach((row) => {
  const article = row.querySelector(".cmp-listedetail__table-productcode")?.textContent?.trim();
  if (!article) return;

  const rawPrice =
    row.querySelector(".cmp-listedetail__table-price")?.textContent ||
    row.querySelector(".cmp-price__price")?.textContent ||
    "";
  const price = parsePrice(rawPrice);

  const name =
    row.querySelector(".cmp-listedetail__table-primary")?.textContent?.trim() ||
    row.querySelector("td")?.textContent?.trim() ||
    "";

  const brand =
    row.querySelector(".cmp-listedetail__table-brand")?.textContent?.trim() ||
    getBrandFromElement(row);
  const imageUrl = getImageFromElement(row);
  addResult(article, price, name, { brand, imageUrl });
});

// ✅ Extra ondersteuning voor "Lijstdetail" pagina's zoals Ontbijt
document.querySelectorAll(".cmp-listdetail__table tbody tr").forEach((tr) => {
  const codeEl = tr.querySelector(".cmp-listdetail__table-productcode");
  if (!codeEl) return;
  const article = codeEl.textContent.trim();

  const name =
    tr.querySelector(".cmp-listdetail__table-title")?.textContent?.trim() ||
    tr.querySelector("h5, h4, h3")?.textContent?.trim() ||
    "";

  const brand =
    tr.querySelector(".cmp-listdetail__table-brandname")?.textContent?.trim() ||
    getBrandFromElement(tr);

  const rawPrice =
    tr.querySelector(".cmp-price__price")?.textContent ||
    tr.querySelector("[class*='price']")?.textContent ||
    "";
  const price = parsePrice(rawPrice);

  addResult(article, price, name, { brand });
});


  return Array.from(resultsMap.values());
}

  },
  hanos: {
    label: "HANOS",
    hosts: ["hanos.nl", "hanos.be"],
    scrape: () => {
      const cleanNameWithBrand = (nameValue, brandValue) => {
        const name = typeof nameValue === "string" ? nameValue.trim() : "";
        if (!name) return "";
        const brand = typeof brandValue === "string" ? brandValue.trim() : "";
        if (!brand) return name;

        const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
        const normalizedBrand = normalize(brand);
        const matchesBrand = (value) => normalize(value) === normalizedBrand;

        const separators = ["|", "-", "–", "—", ":", ";", "/"];
        for (const separator of separators) {
          const idx = name.indexOf(separator);
          if (idx > 0) {
            const possibleBrand = name.slice(0, idx).trim();
            if (possibleBrand && matchesBrand(possibleBrand)) {
              const remainder = name.slice(idx + 1).trim();
              if (remainder) {
                return remainder;
              }
            }
          }
        }

        const lineParts = name.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean);
        if (lineParts.length > 1 && matchesBrand(lineParts[0])) {
          const remainder = lineParts.slice(1).join(" ").trim();
          if (remainder) {
            return remainder;
          }
        }

        const words = name.split(/\s+/);
        const brandWords = brand.split(/\s+/);
        if (brandWords.length && words.length > brandWords.length) {
          const firstWords = words.slice(0, brandWords.length).join(" ");
          if (matchesBrand(firstWords)) {
            return words.slice(brandWords.length).join(" ").trim();
          }
        }

        if (matchesBrand(name)) {
          return "";
        }

        return name;
      };

      const parsePrice = (value) => {
        if (!value) return null;
        const cleaned = value
          .toString()
          .replace(/[^\d,.-]/g, "")
          .replace(/\.(?=\d{3}(?:\D|$))/g, "")
          .replace(",", ".");
        const price = parseFloat(cleaned);
        return Number.isFinite(price) ? price : null;
      };

      const normaliseArticle = (value) => {
        if (!value && value !== 0) return "";
        return value
          .toString()
          .replace(/Art\.?nr\.?/i, "")
          .replace(/[^0-9A-Za-z-]/g, "")
          .trim();
      };

      const toAbsoluteUrl = (value) => {
        if (!value) return "";
        try {
          return new URL(value, window.location.origin).href;
        } catch (err) {
          return "";
        }
      };

      const extractImageSrc = (img) => {
        if (!img) return "";
        const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-lazy") || img.getAttribute("data-original");
        const srcset = img.getAttribute("srcset");
        const firstSrcset = srcset ? srcset.split(",")[0]?.trim().split(/\s+/)[0] : "";
        const raw = dataSrc || img.getAttribute("src") || firstSrcset || "";
        return toAbsoluteUrl(raw);
      };

      const getImageFromElement = (element) => {
        if (!element) return "";
        const img = element.querySelector("img");
        if (img) {
          const url = extractImageSrc(img);
          if (url) return url;
        }
        const source = element.querySelector("picture source");
        if (source) {
          const srcset = source.getAttribute("srcset");
          if (srcset) {
            const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
            const url = toAbsoluteUrl(first);
            if (url) return url;
          }
        }
        return "";
      };

      const getBrandFromElement = (element) => {
        if (!element) return "";
        const brandSelectors = [
          ".product-brand",
          "[data-product-brand]",
          ".product-tile__brand",
          ".product-intro__brand",
          ".product-detail__brand"
        ];
        for (const selector of brandSelectors) {
          const node = element.querySelector(selector);
          if (!node) continue;
          const attrBrand = node.getAttribute?.("data-product-brand") || node.getAttribute?.("data-brand");
          if (attrBrand && attrBrand.trim()) {
            return attrBrand.trim();
          }
          const text = node.textContent?.trim();
          if (text) {
            return text;
          }
        }
        return "";
      };

      const resultsMap = new Map();
      const addResult = (articleNumber, price, name, extra = {}) => {
        const normalized = normaliseArticle(articleNumber);
        if (!normalized) return;
        const existing = resultsMap.get(normalized);
        const displayArticle = articleNumber == null ? "" : String(articleNumber).trim();
        const brand = typeof extra.brand === "string" ? extra.brand.trim() : "";
        const imageUrl = typeof extra.imageUrl === "string" ? toAbsoluteUrl(extra.imageUrl) : "";
        const cleanedName = cleanNameWithBrand(name, brand);
        if (!existing) {
          resultsMap.set(normalized, {
            articleNumber: displayArticle || normalized,
            price: Number.isFinite(price) ? price : null,
            name: cleanedName,
            brand,
            imageUrl
          });
          return;
        }
        if ((existing.price === null || !Number.isFinite(existing.price)) && Number.isFinite(price)) {
          existing.price = price;
        }
        if (!existing.brand && brand) {
          existing.brand = brand;
        }
        const effectiveBrand = existing.brand || brand;
        if (existing.name) {
          existing.name = cleanNameWithBrand(existing.name, effectiveBrand);
        }
        const candidateName = cleanNameWithBrand(name, effectiveBrand);
        if (!existing.name && candidateName) {
          existing.name = candidateName;
        }
        if (!existing.imageUrl && imageUrl) {
          existing.imageUrl = imageUrl;
        }
      };

      const rows = Array.from(document.querySelectorAll(".product-row"));
      rows.forEach((row) => {
        const articleRaw = row.querySelector(".articlenr")?.textContent || "";
        const article = normaliseArticle(articleRaw);
        const priceRaw = row.querySelector(".price")?.textContent || "";
        const price = parsePrice(priceRaw);
        const name = row.querySelector(".product-title-link")?.textContent?.trim();
        const brand = getBrandFromElement(row);
        const imageUrl = getImageFromElement(row);
        addResult(article, price, name, { brand, imageUrl });
      });

      const detailArticleContainer = Array.from(document.querySelectorAll(".product-intro-container"));
      let detailArticle = "";
      detailArticleContainer.forEach((container) => {
        const label = container.querySelector(".product-intro__text-code")?.textContent?.trim();
        if (label?.toLowerCase() === "artikelnummer") {
          const number = container.querySelector(".product-intro__number-code")?.textContent?.trim();
          if (number) {
            detailArticle = number;
          }
        }
      });

      if (detailArticle) {
        const priceWholeRaw = document.querySelector(".price_new")?.textContent || "";
        const priceDecimal = document.querySelector(".price-decimal")?.textContent || "";
        let combined = priceWholeRaw;
        if (priceWholeRaw && priceDecimal) {
          combined = `${priceWholeRaw}${priceDecimal.startsWith(",") || priceWholeRaw.includes(",") ? "" : ","}${priceDecimal}`;
        }
        const price = parsePrice(combined);
        const name = document.querySelector("han-product-summary h1")?.textContent?.trim();
        const brand = document.querySelector(".product-intro__brand")?.textContent?.trim() || "";
        const imageUrl = (() => {
          const img = document.querySelector(
            ".product-gallery__image img, .product-intro__image img, .product-detail__image img"
          );
          return extractImageSrc(img);
        })();
        addResult(detailArticle, price, name, { brand, imageUrl });
      }

      const cards = Array.from(document.querySelectorAll("[data-product-number]"));
      cards.forEach((card) => {
        const article = card.getAttribute("data-product-number") || card.getAttribute("data-articlenumber");
        const price = parsePrice(card.getAttribute("data-price"));
        const name = card.querySelector("[data-product-title]")?.textContent?.trim();
        const brand = getBrandFromElement(card);
        const imageUrl = getImageFromElement(card);
        addResult(article, price, name, { brand, imageUrl });
      });

      return Array.from(resultsMap.values());
    }
  }
};

let currentUser = null;
let selectedHotelUid = null;
let accessibleHotels = [];
let loadButtonEl = null;
let isScraping = false;

const firebaseIndexCache = {
  promise: null,
  hotelUid: null
};

const PRICE_DIFF_THRESHOLD = 0.005;
const KITCHENPILOT_CREATE_URL = "https://kitchenpilot.eu/articles";

const roundPrice = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 10000) / 10000;
};

const updateFirebaseArticlePrice = async (hotelUid, articleId, field, price) => {
  if (!hotelUid) {
    throw new Error("Selecteer eerst een hotel om prijzen te updaten.");
  }
  if (!articleId) {
    throw new Error("Artikel-ID ontbreekt voor prijsupdate.");
  }
  if (!field) {
    throw new Error("Onbekend prijsveld voor dit artikel.");
  }

  const roundedPrice = roundPrice(price);
  if (!Number.isFinite(roundedPrice)) {
    throw new Error("Ongeldige prijs om bij te werken.");
  }

  const articleRef = doc(db, `hotels/${hotelUid}/articles`, articleId);
  const timestamp = Date.now();

  await updateDoc(articleRef, { [field]: roundedPrice, lastPriceUpdate: timestamp });

  try {
    const historyRef = collection(
      db,
      `hotels/${hotelUid}/articles/${articleId}/priceHistory`
    );
    await addDoc(historyRef, { price: roundedPrice, date: timestamp });
  } catch (err) {
    console.warn("Kon prijshistoriek niet bijwerken", err);
  }

  return { price: roundedPrice, timestamp };
};

const updateFirebaseArticleLastChecked = async (hotelUid, articleId) => {
  if (!hotelUid) {
    throw new Error("Selecteer eerst een hotel om de prijscontrole te bevestigen.");
  }
  if (!articleId) {
    throw new Error("Artikel-ID ontbreekt voor het bijwerken van de prijscontrole.");
  }

  const articleRef = doc(db, `hotels/${hotelUid}/articles`, articleId);
  const timestamp = Date.now();

  await updateDoc(articleRef, { lastPriceUpdate: timestamp });

  return { timestamp };
};

const handleUpdateButtonClick = async (button, row, firebasePriceInfo, rows) => {
  if (!selectedHotelUid) {
    updateStatus("Selecteer eerst een hotel om prijzen te kunnen updaten.", "error");
    return;
  }

  const firebaseMatch = row.firebase;
  if (!firebaseMatch?.id) {
    updateStatus("Geen geldig Firebase-artikel gevonden om te updaten.", "error");
    return;
  }

  if (!firebasePriceInfo?.field) {
    updateStatus("Onbekend prijsveld voor dit artikel.", "error");
    return;
  }

  if (!Number.isFinite(row.price)) {
    updateStatus("De webshopprijs is ongeldig.", "error");
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Updaten…";

  try {
    const { price: updatedPrice, timestamp } = await updateFirebaseArticlePrice(
      selectedHotelUid,
      firebaseMatch.id,
      firebasePriceInfo.field,
      row.price
    );
    firebaseMatch[firebasePriceInfo.field] = updatedPrice;
    firebaseMatch.lastPriceUpdate = timestamp;
    updateStatus("Prijs bijgewerkt in Firebase.", "success");
    renderResults(rows);
  } catch (err) {
    console.error("Prijs bijwerken mislukt", err);
    button.disabled = false;
    button.textContent = originalText;
    updateStatus(err.message || "Prijs bijwerken mislukt.", "error");
  }
};

const handlePriceCheckedButtonClick = async (button, row, rows) => {
  if (!selectedHotelUid) {
    updateStatus("Selecteer eerst een hotel om prijzen te kunnen bijwerken.", "error");
    return;
  }

  const firebaseMatch = row.firebase;
  if (!firebaseMatch?.id) {
    updateStatus("Geen geldig Firebase-artikel gevonden om te updaten.", "error");
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Bezig…";

  try {
    const { timestamp } = await updateFirebaseArticleLastChecked(
      selectedHotelUid,
      firebaseMatch.id
    );
    firebaseMatch.lastPriceUpdate = timestamp;
    updateStatus("Laatste prijscontrole geregistreerd.", "success");
    renderResults(rows);
  } catch (err) {
    console.error("Prijscontrole bijwerken mislukt", err);
    button.disabled = false;
    button.textContent = originalText;
    updateStatus(err.message || "Prijscontrole bijwerken mislukt.", "error");
  }
};

const handleCreateArticleClick = async (row) => {
  try {
    const params = new URLSearchParams();
    params.set("prefillArticle", "1");
    if (row?.name) {
      params.set("name", row.name);
    }
    if (row?.brand) {
      params.set("brand", row.brand);
    }
    if (row?.articleNumber) {
      params.set("articleNumber", row.articleNumber);
    }
    const priceValue = roundPrice(row?.price);
    if (Number.isFinite(priceValue)) {
      params.set("pricePerPurchaseUnit", priceValue.toString());
    }
    if (row?.supplier) {
      params.set("supplier", row.supplier);
    }
    if (typeof row?.imageUrl === "string" && row.imageUrl) {
      params.set("imageUrl", row.imageUrl);
    }
    const url = `${KITCHENPILOT_CREATE_URL}?${params.toString()}`;

    try {
      await chromeApi.windowsCreate({ url, focused: true });
    } catch (windowErr) {
      console.warn("Kon KitchenPilot niet openen in een nieuw venster, val terug op tab", windowErr);
      await chromeApi.tabsCreate({ url });
    }
    updateStatus("Artikelcreatie geopend in KitchenPilot.", "success");
  } catch (err) {
    console.error("Kon KitchenPilot niet openen voor artikelcreatie", err);
    updateStatus("Kon KitchenPilot niet openen om artikel aan te maken.", "error");
  }
};

const updateLoadButtonState = () => {
  if (!loadButtonEl) return;
  const shouldDisable = isScraping || !currentUser || !selectedHotelUid;
  loadButtonEl.disabled = shouldDisable;
};

const chromeApi = {
  tabsQuery: (queryInfo) =>
    new Promise((resolve, reject) => {
      chrome.tabs.query(queryInfo, (tabs) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(tabs);
      });
    }),
  tabsCreate: (createProperties) =>
    new Promise((resolve, reject) => {
      chrome.tabs.create(createProperties, (tab) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(tab);
      });
    }),
  windowsCreate: (createData) =>
    new Promise((resolve, reject) => {
      chrome.windows.create(createData, (createdWindow) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(createdWindow);
      });
    }),
  storageGet: (keys) =>
    new Promise((resolve) => {
      chrome.storage.local.get(keys, (items) => resolve(items));
    }),
  storageSet: (items) =>
    new Promise((resolve) => {
      chrome.storage.local.set(items, () => resolve());
    }),
  storageRemove: (keys) =>
    new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    })
};

const getLookupKeys = (value) => {
  if (value === undefined || value === null) return [];
  const str = String(value);
  const keys = [];
  const trimmed = str.trim();
  if (trimmed) {
    keys.push(trimmed.toLowerCase());
  }
  const noSpaces = trimmed.replace(/\s+/g, "");
  if (noSpaces && !keys.includes(noSpaces.toLowerCase())) {
    keys.push(noSpaces.toLowerCase());
  }
  const alnum = noSpaces.replace(/[^0-9a-zA-Z]/g, "");
  if (alnum && !keys.includes(alnum.toLowerCase())) {
    keys.push(alnum.toLowerCase());
  }
  const withoutLeadingZeros = alnum.replace(/^0+/, "");
  if (withoutLeadingZeros && !keys.includes(withoutLeadingZeros.toLowerCase())) {
    keys.push(withoutLeadingZeros.toLowerCase());
  }
  return keys.filter(Boolean);
};

const resetFirebaseIndex = () => {
  firebaseIndexCache.promise = null;
  firebaseIndexCache.hotelUid = null;
};

const buildFirebaseIndex = async (hotelUid) => {
  if (!hotelUid) {
    throw new Error("Geen hotel geselecteerd.");
  }
  const snapshot = await getDocs(collection(db, `hotels/${hotelUid}/articles`));
  const index = new Map();
  const articles = [];
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    const article = {
      id: docSnap.id,
      ...data
    };
    articles.push(article);
    const keys = getLookupKeys(data.articleNumber);
    keys.forEach((key) => {
      if (!index.has(key)) {
        index.set(key, []);
      }
      index.get(key).push(article);
    });
  });
  return { index, articles };
};

const getFirebaseIndex = (hotelUid) => {
  if (!firebaseIndexCache.promise || firebaseIndexCache.hotelUid !== hotelUid) {
    const promise = buildFirebaseIndex(hotelUid).catch((err) => {
      if (firebaseIndexCache.promise === promise) {
        firebaseIndexCache.promise = null;
        firebaseIndexCache.hotelUid = null;
      }
      throw err;
    });
    firebaseIndexCache.promise = promise;
    firebaseIndexCache.hotelUid = hotelUid;
  }
  return firebaseIndexCache.promise;
};

const findFirebaseMatch = (index, articleNumber) => {
  const keys = getLookupKeys(articleNumber);
  for (const key of keys) {
    const matches = index.get(key);
    if (matches?.length) {
      return matches[0];
    }
  }
  return null;
};

const loadAccessibleHotels = async (user) => {
  if (!user?.uid) {
    throw new Error("Geen gebruiker aangemeld.");
  }

  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) {
    throw new Error("Gebruikersprofiel niet gevonden.");
  }

  const data = userSnap.data() || {};
  let hotelIds = data?.hotelUids || data?.hotelUid || [];
  if (!Array.isArray(hotelIds)) {
    hotelIds = [hotelIds];
  }

  hotelIds = hotelIds
    .map((uid) => (typeof uid === "string" ? uid.trim() : ""))
    .filter(Boolean);

  if (!hotelIds.length) {
    throw new Error("Er zijn geen hotels aan dit account gekoppeld.");
  }

  hotelIds = Array.from(new Set(hotelIds));

  const hotels = await Promise.all(
    hotelIds.map(async (uid) => {
      try {
        const settingsRef = doc(db, `hotels/${uid}/settings`, uid);
        const settingsSnap = await getDoc(settingsRef);
        const settings = settingsSnap.exists() ? settingsSnap.data() : {};
        const nameRaw = settings?.hotelName;
        const name = typeof nameRaw === "string" && nameRaw.trim()
          ? nameRaw.trim()
          : uid;
        return { uid, name };
      } catch (err) {
        console.warn("Kon hotelgegevens niet laden voor", uid, err);
        return { uid, name: uid };
      }
    })
  );

  return hotels;
};

const mapAuthError = (error) => {
  const code = error?.code || "";
  switch (code) {
    case "auth/invalid-email":
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "Onjuiste inloggegevens. Controleer je e-mailadres en wachtwoord.";
    case "auth/too-many-requests":
      return "Te veel mislukte pogingen. Probeer het later opnieuw.";
    case "auth/network-request-failed":
      return "Netwerkfout tijdens het inloggen. Controleer je verbinding.";
    default:
      return error?.message || "Inloggen is mislukt. Probeer het opnieuw.";
  }
};

const formatPrice = (value) => {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR"
  }).format(value);
};

const escapeHtml = (value) => {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const toNumberOrNull = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const getFirebasePriceInfo = (match) => {
  if (!match) {
    return { value: null, unitLabel: "", isWeighed: false, field: null };
  }

  const candidates = [];
  if (match.isWeighed) {
    candidates.push({
      field: "pricePerKg",
      value: toNumberOrNull(match.pricePerKg),
      unitLabel: "/kg"
    });
    candidates.push({
      field: "pricePerStockUnit",
      value: toNumberOrNull(match.pricePerStockUnit),
      unitLabel: match.stockUnit ? `/${match.stockUnit}` : ""
    });
    candidates.push({
      field: "pricePerPurchaseUnit",
      value: toNumberOrNull(match.pricePerPurchaseUnit),
      unitLabel: ""
    });
  } else {
    candidates.push({
      field: "pricePerPurchaseUnit",
      value: toNumberOrNull(match.pricePerPurchaseUnit),
      unitLabel: ""
    });
  }

  const selected = candidates.find((candidate) => candidate.value !== null);
  if (selected) {
    return { ...selected, isWeighed: Boolean(match.isWeighed) };
  }

  const fallback = candidates[0] || { field: null, unitLabel: "" };
  return {
    value: null,
    unitLabel: fallback.unitLabel,
    isWeighed: Boolean(match.isWeighed),
    field: fallback.field
  };
};

const renderResults = (rows) => {
  const resultsSection = document.getElementById("results");
  const rowsContainer = document.getElementById("resultRows");
  rowsContainer.innerHTML = "";

  if (!rows.length) {
    resultsSection.classList.add("hidden");
    return;
  }

  rows.forEach((row) => {
    const firebaseMatch = row.firebase;
    const firebasePriceInfo = getFirebasePriceInfo(firebaseMatch);
    const firebasePriceValue = firebasePriceInfo.value;
    const difference = Number.isFinite(row.price) && Number.isFinite(firebasePriceValue)
      ? row.price - firebasePriceValue
      : null;

    const hasDifference = Number.isFinite(difference) && Math.abs(difference) >= PRICE_DIFF_THRESHOLD;
    const differenceLabel = hasDifference
      ? `<span class="difference">Δ ${formatPrice(difference)}</span>`
      : "";

    const unitSuffix = firebasePriceInfo.unitLabel && firebasePriceValue !== null
      ? `<span class="unit">${escapeHtml(firebasePriceInfo.unitLabel)}</span>`
      : "";

    const firebasePriceContent = `${formatPrice(firebasePriceValue)}${unitSuffix}${differenceLabel}`;

    const rowUnitSuffix = firebasePriceInfo.isWeighed && Number.isFinite(row.price)
      ? `<span class="unit">${escapeHtml(firebasePriceInfo.unitLabel)}</span>`
      : "";

    const webshopPriceContent = `${formatPrice(row.price)}${rowUnitSuffix}`;

    const actionButtons = [];
    const shouldShowUpdateButton = hasDifference && firebaseMatch && firebasePriceInfo.field && Number.isFinite(row.price);
    if (shouldShowUpdateButton) {
      actionButtons.push(
        '<button type="button" class="secondary-btn update-price-btn">Prijs updaten</button>'
      );
    }

    const shouldShowPriceCheckedButton =
      !hasDifference &&
      firebaseMatch &&
      firebasePriceInfo.field &&
      Number.isFinite(row.price) &&
      Number.isFinite(firebasePriceValue);

    if (shouldShowPriceCheckedButton) {
      actionButtons.push(
        '<button type="button" class="secondary-btn price-checked-btn">Price Checked</button>'
      );
    }

    const actionsHtml = actionButtons.length
      ? `<div class="result-actions">${actionButtons.join("")}</div>`
      : "";

    const createArticleHtml = !firebaseMatch
      ? `
          <div class="result-actions">
            <button type="button" class="secondary-btn create-article-btn">Create article</button>
          </div>
        `
      : "";

    const firebaseCell = firebaseMatch
      ? `
          <div class="result-cell">
            <span class="result-title">${escapeHtml(firebaseMatch.articleNumber || firebaseMatch.id)}</span>
            <span class="result-price ${differenceLabel ? "mismatch" : ""}">
              ${firebasePriceContent}
            </span>
            ${firebaseMatch.name ? `<span class="result-meta">${escapeHtml(firebaseMatch.name)}</span>` : ""}
            <span class="badge success">Firebase match</span>
            ${actionsHtml}
          </div>
        `
      : `
          <div class="result-cell empty">
            <span class="badge warning">Geen match</span>
            <span>Geen overeenkomend artikel gevonden</span>
            ${createArticleHtml}
          </div>
        `;

    const webshopCell = `
        <div class="result-cell">
          <span class="result-title">${escapeHtml(row.articleNumber)}</span>
          <span class="result-price">${webshopPriceContent}</span>
          ${row.name ? `<span class="result-meta">${escapeHtml(row.name)}</span>` : ""}
          <span class="badge">Webshop</span>
        </div>
      `;

    const rowElement = document.createElement("div");
    rowElement.className = "result-row";
    rowElement.innerHTML = `${webshopCell}${firebaseCell}`;
    rowsContainer.appendChild(rowElement);

    if (shouldShowUpdateButton) {
      const updateBtn = rowElement.querySelector(".update-price-btn");
      if (updateBtn) {
        updateBtn.addEventListener("click", () => {
          handleUpdateButtonClick(updateBtn, row, firebasePriceInfo, rows);
        });
      }
    }

    if (shouldShowPriceCheckedButton) {
      const checkedBtn = rowElement.querySelector(".price-checked-btn");
      if (checkedBtn) {
        checkedBtn.addEventListener("click", () => {
          handlePriceCheckedButtonClick(checkedBtn, row, rows);
        });
      }
    }

    if (!firebaseMatch) {
      const createBtn = rowElement.querySelector(".create-article-btn");
      if (createBtn) {
        createBtn.addEventListener("click", () => {
          handleCreateArticleClick(row);
        });
      }
    }
  });

  resultsSection.classList.remove("hidden");
};

const updateStatus = (message, type = "") => {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message;
  statusEl.classList.remove("error", "success");
  if (type) {
    statusEl.classList.add(type);
  }
};

const setLoading = (isLoading) => {
  isScraping = isLoading;
  if (!loadButtonEl) return;
  if (isLoading) {
    loadButtonEl.disabled = true;
    loadButtonEl.textContent = "Bezig…";
  } else {
    loadButtonEl.textContent = "Load prices";
    updateLoadButtonState();
  }
};

const scrapeWebshop = async (shopKey) => {
  const option = SHOP_OPTIONS[shopKey];
  if (!option) {
    throw new Error("Onbekende webshop geselecteerd.");
  }

  const tabs = await chromeApi.tabsQuery({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id) {
    throw new Error("Geen actieve tab gevonden.");
  }
  if (!tab.url) {
    throw new Error("Kan de URL van de pagina niet bepalen.");
  }

  let url;
  try {
    url = new URL(tab.url);
  } catch (err) {
    throw new Error("Ongeldige URL van de huidige pagina.");
  }

  const matchesHost = option.hosts.some((domain) => url.hostname.endsWith(domain));
  if (!matchesHost) {
    throw new Error(`Open een ${option.label}-pagina om prijzen te laden.`);
  }

  const injectionResult = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: option.scrape
  });

  const [{ result }] = injectionResult;
  const data = Array.isArray(result) ? result : [];
  const supplierName = option.label;
  const unique = new Map();
  data.forEach((item) => {
    if (!item?.articleNumber) return;
    const key = item.articleNumber.trim().toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, {
        articleNumber: item.articleNumber.trim(),
        price: Number.isFinite(item.price) ? item.price : null,
        name: item.name || "",
        brand: typeof item.brand === "string" ? item.brand.trim() : "",
        imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : "",
        supplier: typeof item.supplier === "string" && item.supplier.trim()
          ? item.supplier.trim()
          : supplierName,
        firebase: null
      });
    } else {
      const existing = unique.get(key);
      if ((existing.price === null || !Number.isFinite(existing.price)) && Number.isFinite(item.price)) {
        existing.price = item.price;
      }
      if (!existing.name && item.name) {
        existing.name = item.name;
      }
      if (!existing.brand && typeof item.brand === "string" && item.brand.trim()) {
        existing.brand = item.brand.trim();
      }
      if (!existing.imageUrl && typeof item.imageUrl === "string" && item.imageUrl) {
        existing.imageUrl = item.imageUrl;
      }
      if (!existing.supplier) {
        const itemSupplier = typeof item.supplier === "string" && item.supplier.trim()
          ? item.supplier.trim()
          : supplierName;
        existing.supplier = itemSupplier;
      }
    }
  });

  return Array.from(unique.values()).sort((a, b) => a.articleNumber.localeCompare(b.articleNumber));
};

document.addEventListener("DOMContentLoaded", () => {
  const loginSection = document.getElementById("loginSection");
  const loginForm = document.getElementById("loginForm");
  const loginEmailInput = document.getElementById("loginEmail");
  const loginPasswordInput = document.getElementById("loginPassword");
  const loginErrorEl = document.getElementById("loginError");
  const loginButtonEl = document.getElementById("loginBtn");
  const accountSection = document.getElementById("accountSection");
  const accountEmailEl = document.getElementById("accountEmail");
  const logoutBtn = document.getElementById("logoutBtn");
  const controlsSection = document.getElementById("controlsSection");
  const selectEl = document.getElementById("webshopSelect");
  loadButtonEl = document.getElementById("loadPricesBtn");
  const hotelSelect = document.getElementById("hotelSelect");
  const hotelStatus = document.getElementById("hotelStatus");

  const showElement = (el) => {
    if (!el) return;
    el.classList.remove("hidden");
  };

  const hideElement = (el) => {
    if (!el) return;
    el.classList.add("hidden");
  };

  const setLoginError = (message) => {
    if (!loginErrorEl) return;
    loginErrorEl.textContent = message || "";
    loginErrorEl.classList.toggle("hidden", !message);
    loginErrorEl.classList.toggle("error", Boolean(message));
  };

  const setLoginLoading = (isLoading) => {
    if (loginButtonEl) {
      loginButtonEl.disabled = isLoading;
      loginButtonEl.textContent = isLoading ? "Inloggen…" : "Inloggen";
    }
    if (loginEmailInput) {
      loginEmailInput.disabled = isLoading;
    }
    if (loginPasswordInput) {
      loginPasswordInput.disabled = isLoading;
    }
  };

  const setHotelStatus = (message, type = "") => {
    if (!hotelStatus) return;
    hotelStatus.textContent = message || "";
    hotelStatus.classList.remove("error");
    if (type === "error") {
      hotelStatus.classList.add("error");
    }
  };

  const populateHotelSelect = (hotels) => {
    if (!hotelSelect) return;
    hotelSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = hotels.length ? "Selecteer een hotel" : "Geen hotels beschikbaar";
    placeholder.disabled = true;
    placeholder.selected = true;
    hotelSelect.appendChild(placeholder);
    hotels.forEach(({ uid, name }) => {
      const option = document.createElement("option");
      option.value = uid;
      option.textContent = name && name !== uid ? `${name} (${uid})` : uid;
      hotelSelect.appendChild(option);
    });
    hotelSelect.disabled = !hotels.length;
  };

  const setSelectedHotel = async (uid, { persist = true } = {}) => {
    selectedHotelUid = uid || null;
    if (hotelSelect) {
      if (uid) {
        hotelSelect.value = uid;
      } else if (hotelSelect.options.length) {
        hotelSelect.value = "";
      }
    }
    resetFirebaseIndex();
    if (persist) {
      try {
        if (uid) {
          await chromeApi.storageSet({ kp_selected_hotel: uid });
        } else {
          await chromeApi.storageRemove(["kp_selected_hotel"]);
        }
      } catch (err) {
        console.warn("Kon hotelvoorkeur niet opslaan", err);
      }
    }
    if (uid) {
      setHotelStatus("");
      updateStatus("", "");
    }
    updateLoadButtonState();
  };

  const clearResults = () => {
    renderResults([]);
  };

  const handleLoggedOut = async () => {
    currentUser = null;
    accessibleHotels = [];
    await setSelectedHotel(null, { persist: false });
    if (hotelSelect) {
      hotelSelect.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Log in om hotels te laden";
      placeholder.disabled = true;
      placeholder.selected = true;
      hotelSelect.appendChild(placeholder);
      hotelSelect.disabled = true;
    }
    setHotelStatus("Log in om hotels te laden.");
    if (accountEmailEl) {
      accountEmailEl.textContent = "";
    }
    hideElement(accountSection);
    hideElement(controlsSection);
    showElement(loginSection);
    if (loginForm) {
      loginForm.reset();
    }
    setLoginError("");
    setLoginLoading(false);
    chromeApi.storageRemove(["kp_selected_hotel"]).catch(() => {});
    updateStatus("", "");
    clearResults();
    updateLoadButtonState();
  };

  const handleLoggedIn = async (user) => {
    currentUser = user;
    hideElement(loginSection);
    setLoginError("");
    setLoginLoading(false);
    showElement(accountSection);
    showElement(controlsSection);
    if (accountEmailEl) {
      accountEmailEl.textContent = user.email || user.displayName || user.uid || "";
    }
    setHotelStatus("Hotels worden geladen…");
    updateLoadButtonState();

    try {
      const stored = await chromeApi.storageGet(["kp_selected_hotel"]);
      const storedHotelUid = stored?.kp_selected_hotel || null;
      accessibleHotels = await loadAccessibleHotels(user);
      populateHotelSelect(accessibleHotels);
      if (accessibleHotels.length) {
        const defaultUid = accessibleHotels.some((hotel) => hotel.uid === storedHotelUid)
          ? storedHotelUid
          : accessibleHotels[0]?.uid || null;
        if (defaultUid) {
          await setSelectedHotel(defaultUid, { persist: defaultUid !== storedHotelUid });
        } else {
          await setSelectedHotel(null, { persist: false });
        }
        setHotelStatus(
          accessibleHotels.length > 1
            ? "Selecteer het hotel waarvoor je wilt vergelijken."
            : ""
        );
      } else {
        await setSelectedHotel(null, { persist: false });
        setHotelStatus("Geen hotels beschikbaar voor dit account.", "error");
      }
    } catch (err) {
      console.error("Fout bij het laden van hotels", err);
      accessibleHotels = [];
      populateHotelSelect([]);
      await setSelectedHotel(null, { persist: false });
      setHotelStatus(err.message || "Hotels konden niet geladen worden.", "error");
    }

    updateLoadButtonState();
  };

  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = loginEmailInput?.value?.trim() || "";
      const password = loginPasswordInput?.value || "";
      if (!email || !password) {
        setLoginError("Vul je e-mailadres en wachtwoord in.");
        return;
      }
      try {
        setLoginLoading(true);
        setLoginError("");
        await signInWithEmailAndPassword(auth, email, password);
      } catch (err) {
        console.error("Inloggen mislukt", err);
        setLoginError(mapAuthError(err));
      } finally {
        setLoginLoading(false);
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await signOut(auth);
      } catch (err) {
        console.error("Fout bij uitloggen", err);
        updateStatus(err.message || "Uitloggen is mislukt.", "error");
      }
    });
  }

  if (hotelSelect) {
    hotelSelect.addEventListener("change", (event) => {
      const value = event.target.value;
      if (!value) return;
      setSelectedHotel(value).catch((err) => {
        console.error("Fout bij opslaan van hotelkeuze", err);
        updateStatus(err.message || "Kon hotelkeuze niet opslaan.", "error");
      });
    });
  }

  if (selectEl) {
    chromeApi.storageGet(["kp_last_webshop"]).then((stored) => {
      const storedShop = stored?.kp_last_webshop;
      if (storedShop && SHOP_OPTIONS[storedShop]) {
        selectEl.value = storedShop;
      }
    });

    selectEl.addEventListener("change", () => {
      const value = selectEl.value;
      if (value) {
        chromeApi.storageSet({ kp_last_webshop: value });
      }
    });
  }

  updateLoadButtonState();

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      await handleLoggedIn(user);
    } else {
      await handleLoggedOut();
    }
  });

  if (loadButtonEl) {
    loadButtonEl.addEventListener("click", async () => {
      const shopKey = selectEl?.value;
      if (!shopKey) {
        updateStatus("Selecteer eerst een webshop.", "error");
        return;
      }
      if (!currentUser) {
        updateStatus("Log eerst in met je KitchenPilot-account.", "error");
        return;
      }
      if (!selectedHotelUid) {
        updateStatus("Selecteer een hotel om prijzen te vergelijken.", "error");
        return;
      }

      try {
        setLoading(true);
        updateStatus("Prijzen laden…");
        const webshopRows = await scrapeWebshop(shopKey);
        if (!webshopRows.length) {
          renderResults([]);
          updateStatus("Geen artikelnummers gevonden op deze pagina.", "error");
          return;
        }

        const { index } = await getFirebaseIndex(selectedHotelUid);
        const mapped = webshopRows.map((row) => ({
          ...row,
          firebase: findFirebaseMatch(index, row.articleNumber)
        }));

        renderResults(mapped);
        const matchCount = mapped.filter((row) => row.firebase).length;
        const message = `${webshopRows.length} artikel${webshopRows.length === 1 ? "" : "en"} gevonden — ${matchCount} match${matchCount === 1 ? "" : "es"} in Firebase.`;
        updateStatus(message, matchCount ? "success" : "");
      } catch (err) {
        console.error("Fout bij het laden van prijzen", err);
        updateStatus(err.message || "Onbekende fout.", "error");
      } finally {
        setLoading(false);
      }
    });
  }
});
