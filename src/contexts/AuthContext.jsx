import { createContext, useContext } from "react";

// Authentication and platform authority are independent of a selected hotel.
export const AuthContext = createContext(null);
export function useAuthContext() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Authentication context is unavailable.");
  return value;
}
