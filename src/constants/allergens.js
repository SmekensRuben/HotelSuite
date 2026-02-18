// src/constants/allergens.js
import {
  GiWheat,
  GiShrimp,
  GiFriedEggs,
  GiFishbone,
  GiPeanut,
  GiBeanstalk,
  GiMilkCarton,
  GiCoconuts,
  GiHerbsBundle,
  GiSesame,
  GiChemicalDrop,
  GiSnail,
} from "react-icons/gi";
import { LuFlaskConical, LuFlower2 } from "react-icons/lu";

export const ALLERGENS = [
  "gluten",
  "crustaceans",
  "eggs",
  "fish",
  "peanuts",
  "soybeans",
  "milk",
  "nuts",
  "celery",
  "mustard",
  "sesame",
  "sulphur",
  "lupin",
  "molluscs",
];

export const ALLERGEN_ICONS = {
  gluten: GiWheat,
  crustaceans: GiShrimp,
  eggs: GiFriedEggs,
  fish: GiFishbone,
  peanuts: GiPeanut,
  soybeans: GiBeanstalk,
  milk: GiMilkCarton,
  nuts: GiCoconuts,
  celery: GiHerbsBundle,
  mustard: LuFlaskConical,
  sesame: GiSesame,
  sulphur: GiChemicalDrop,
  lupin: LuFlower2,
  molluscs: GiSnail,
};
