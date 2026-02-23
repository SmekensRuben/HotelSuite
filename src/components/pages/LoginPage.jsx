import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  auth,
  signInWithEmailAndPassword
} from "../../firebaseConfig";
import { useHotelContext } from 'contexts/HotelContext';

import { useTranslation } from "react-i18next";


export default function LoginPage() {
  const { t } = useTranslation("auth");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { hotelUid, loading } = useHotelContext();



  useEffect(() => {
    const savedEmail = localStorage.getItem("rememberEmail");
    if (savedEmail) {
      setEmail(savedEmail);
      setRememberMe(true);
    }
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");

    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      const user = result.user;

      if (rememberMe) {
        localStorage.setItem("rememberEmail", email);
      } else {
        localStorage.removeItem("rememberEmail");
      }
    } catch (err) {
     setError(t("loginError"));
      console.error(err);
    }
  };

useEffect(() => {
  if (auth.currentUser && hotelUid && !loading) {
    navigate("/dashboard");
  }
}, [hotelUid, loading, navigate]);



  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* ✅ HEADER */}
      <header className="bg-[#b41f1f] text-white shadow-sm w-full">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <img
              src="/assets/breakfast_pilot_logo_black_circle.png"
              alt="Hotel Toolkit Logo"
              className="h-10"
            />
            <h1 className="text-2xl font-bold tracking-wide">Hotel Toolkit</h1>
          </div>
          <button
            onClick={() => navigate("/")}
            className="bg-white text-[#b41f1f] px-4 py-2 rounded hover:bg-gray-100 text-sm font-semibold"
          >
            {t("back")}
          </button>
        </div>
      </header>

      {/* ✅ LOGIN BLOK */}
      <div className="flex-grow flex items-center justify-center px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="bg-white shadow-lg rounded-lg max-w-md w-full p-8"
        >
          <div className="flex flex-col items-center mb-6">
            <img
              src="/assets/breakfast_pilot_logo_black_circle.png"
              alt="Hotel Toolkit Logo"
              className="h-16 mb-2"
            />
            <h1 className="text-2xl font-bold text-[#b41f1f]">{t("loginTitle")}</h1>
            <p className="text-gray-600 text-sm mt-1 text-center">
              {t("loginSubtitle")}
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("email")}
              required
              className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring focus:border-[#b41f1f]"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("password")}
              required
              className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring focus:border-[#b41f1f]"
            />
            <label className="flex items-center text-sm text-gray-600">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="mr-2"
              />
              {t("rememberMe")}
            </label>
            <button
              type="submit"
              className="w-full bg-[#b41f1f] text-white py-2 rounded hover:bg-red-700 transition"
            >
              {t("loginButton")}
            </button>
          </form>

          <p className="text-xs text-center text-gray-400 mt-6">
            &copy; {new Date().getFullYear()} Hotel Toolkit
          </p>
        </motion.div>
      </div>
    </div>
  );
}
