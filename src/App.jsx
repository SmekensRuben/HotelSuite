import AppRouter from "./AppRouter";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { SupplierAiImportProgressProvider } from "./contexts/SupplierAiImportProgressContext";

export default function App() {
  return (
    <SupplierAiImportProgressProvider>
      <AppRouter />
      <ToastContainer position="bottom-right" autoClose={3500} />
    </SupplierAiImportProgressProvider>
  );
}
