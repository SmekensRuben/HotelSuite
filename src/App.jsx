import AppRouter from "./AppRouter";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

export default function App() {
  return (
    <>
      <AppRouter />
      <ToastContainer position="bottom-right" autoClose={3500} />
    </>
  );
}
