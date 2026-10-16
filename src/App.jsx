import AppRouter from "./AppRouter";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { SupplierAiImportProgressProvider } from "./contexts/SupplierAiImportProgressContext";
import StagingReleaseGuard from "./components/StagingReleaseGuard";

export default function App() {
  return (
    <StagingReleaseGuard><SupplierAiImportProgressProvider>
      <AppRouter />
      <ToastContainer position="bottom-right" autoClose={3500} />
    </SupplierAiImportProgressProvider></StagingReleaseGuard>
  );
}
