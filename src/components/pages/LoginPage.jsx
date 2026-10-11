import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Brand from "../layout/Brand";
import { ShieldCheck, Users, Layers } from "lucide-react";
import {
  getMultiFactorResolver,
  multiFactor,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
  sendEmailVerification,
  signOut,
  TotpMultiFactorGenerator,
} from "firebase/auth";
import {
  auth,
  authPolicy,
  signInWithEmailAndPassword,
} from "../../firebaseConfig";
import { useHotelContext } from "../../contexts/HotelContext";
import { workspaceHome } from "../../utils/workspace";
import { useTranslation } from "react-i18next";

const SCREENS = {
  LOGIN: "login",
  VERIFY_EMAIL: "verify-email",
  ENROLL_2FA: "enroll-2fa",
  VERIFY_2FA: "verify-2fa",
};

const hasSecondFactor = (user) => multiFactor(user).enrolledFactors.length > 0;
const VERIFICATION_COOLDOWN_MS = 60_000;

const verificationStorageKey = (user) =>
  `verificationEmailSentAt:${user?.uid || user?.email || "unknown"}`;

// Firebase expects phone numbers in E.164 format. The form deliberately allows
// readable separators, so strip those before sending the number to Firebase.
const normalizePhoneNumber = (value) => value.trim().replace(/[\s().-]/g, "");

const isRecaptchaError = (err) =>
  /(?:re-?captcha|grecaptcha|captcha)/i.test(
    `${err?.name || ""} ${err?.message || ""}`,
  );

const isUnauthorizedDomainError = (err) =>
  err?.code === "auth/unauthorized-domain" ||
  /hostname match not found|unauthori[sz]ed domain/i.test(err?.message || "");

const isBrowserNetworkError = (err) =>
  err?.name === "NetworkError" ||
  (err?.name === "TypeError" &&
    /(?:fetch|network|load|blocked)/i.test(err?.message || ""));

export default function LoginPage() {
  const { t } = useTranslation("auth");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [screen, setScreen] = useState(SCREENS.LOGIN);
  const [verificationCode, setVerificationCode] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneVerificationId, setPhoneVerificationId] = useState("");
  const [enrollmentSession, setEnrollmentSession] = useState(null);
  const [mfaResolver, setMfaResolver] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const navigate = useNavigate();
  const { hotelUid, hotelUids, isPlatformAdmin, loading, authLoading } =
    useHotelContext();
  const home = workspaceHome({
    isPlatformAdmin,
    hotelUids: hotelUids || (hotelUid ? [hotelUid] : []),
  });
  const recaptchaVerifierRef = useRef(null);
  const phoneChallengeStartedRef = useRef(false);

  const getRecaptchaVerifier = useCallback(() => {
    if (!recaptchaVerifierRef.current) {
      recaptchaVerifierRef.current = new RecaptchaVerifier(
        auth,
        "recaptcha-container",
        // A visible challenge is intentional. Invisible reCAPTCHA is more
        // likely to be rejected by browser tracking protection and privacy
        // extensions, which makes SMS MFA device-dependent.
        { size: "normal" },
      );
    }
    return recaptchaVerifierRef.current;
  }, []);

  useEffect(() => () => recaptchaVerifierRef.current?.clear(), []);

  useEffect(() => {
    if (!resendCooldown) return undefined;
    const timer = window.setInterval(() => {
      setResendCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown]);

  const verificationErrorMessage = useCallback(
    (err) => {
      switch (err?.code) {
        case "auth/too-many-requests":
          return t("verificationTooManyRequests");
        case "auth/network-request-failed":
          return t("verificationNetworkError");
        case "auth/user-token-expired":
        case "auth/requires-recent-login":
          return t("verificationLoginExpired");
        case "auth/operation-not-allowed":
          return t("verificationNotEnabled");
        default:
          return t("verificationSendErrorWithCode", {
            code: err?.code || "unknown",
          });
      }
    },
    [t],
  );

  const enrollmentErrorMessage = useCallback(
    (err) => {
      // Identity Toolkit returns captcha-check-failed when the deployment host is
      // absent from Firebase Authentication's authorized domains. Distinguish
      // that configuration problem from a challenge blocked by the browser.
      if (isUnauthorizedDomainError(err)) {
        return t("recaptchaUnauthorizedDomain", {
          hostname: window.location.hostname,
        });
      }

      switch (err?.code) {
        case "auth/operation-not-allowed":
        case "auth/admin-restricted-operation":
          return t("twoFactorNotEnabled");
        case "auth/requires-recent-login":
        case "auth/user-token-expired":
        case "auth/invalid-user-token":
          return t("twoFactorLoginExpired");
        case "auth/unsupported-first-factor":
          return t("twoFactorUnsupportedFirstFactor");
        case "auth/network-request-failed":
          return t("twoFactorNetworkError");
        case "auth/invalid-phone-number":
        case "auth/missing-phone-number":
          return t("invalidPhoneNumber");
        case "auth/captcha-check-failed":
        case "auth/missing-app-credential":
        case "auth/invalid-app-credential":
          return t("recaptchaError");
        case "auth/quota-exceeded":
        case "auth/too-many-requests":
          return t("smsTooManyRequests");
        case "auth/invalid-multi-factor-session":
        case "auth/missing-multi-factor-session":
          return t("twoFactorInvalidSession");
        default:
          if (isRecaptchaError(err)) return t("recaptchaError");
          if (isBrowserNetworkError(err)) return t("twoFactorNetworkError");
          return err?.code
            ? t("twoFactorSetupErrorWithCode", { code: err.code })
            : t("twoFactorUnexpectedError");
      }
    },
    [t],
  );

  const sendVerification = useCallback(
    async (user, { respectCooldown = true } = {}) => {
      if (!user) throw new Error("auth/no-current-user");

      const key = verificationStorageKey(user);
      const lastSentAt = Number(localStorage.getItem(key)) || 0;
      const remainingMs = VERIFICATION_COOLDOWN_MS - (Date.now() - lastSentAt);
      if (respectCooldown && remainingMs > 0) {
        setResendCooldown(Math.ceil(remainingMs / 1000));
        setNotice(t("verificationEmailAlreadySent"));
        return false;
      }

      await sendEmailVerification(user);
      localStorage.setItem(key, String(Date.now()));
      setResendCooldown(VERIFICATION_COOLDOWN_MS / 1000);
      setNotice(t("verificationEmailSent"));
      return true;
    },
    [t],
  );

  useEffect(() => {
    const savedEmail = localStorage.getItem("rememberEmail");
    if (savedEmail) {
      setEmail(savedEmail);
      setRememberMe(true);
    }
  }, []);

  const startEnrollment = useCallback(
    async (user) => {
      setBusy(true);
      setError("");
      setPhoneVerificationId("");
      setEnrollmentSession(null);
      setScreen(SCREENS.ENROLL_2FA);
      try {
        // Refresh the user and ID token so Firebase sees a newly verified email
        // before creating the MFA enrollment session.
        await user.reload();
        await user.getIdToken(true);
        const session = await multiFactor(user).getSession();
        setEnrollmentSession(session);
      } catch (err) {
        console.error(err);
        setError(enrollmentErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [enrollmentErrorMessage, t],
  );

  const continueAfterPrimaryLogin = useCallback(
    async (user, shouldSendVerification = true) => {
      if (!user.emailVerified) {
        setScreen(SCREENS.VERIFY_EMAIL);
        setNotice(t("emailNotVerified"));
        if (shouldSendVerification) {
          try {
            await sendVerification(user);
          } catch (err) {
            console.error(err);
            setError(verificationErrorMessage(err));
          }
        }
        return;
      }

      if (authPolicy.requireMfa && !hasSecondFactor(user)) {
        await startEnrollment(user);
        return;
      }

      if (!(authLoading ?? loading)) navigate(home);
    },
    [
      authLoading,
      loading,
      home,
      navigate,
      sendVerification,
      startEnrollment,
      t,
      verificationErrorMessage,
    ],
  );

  useEffect(() => {
    const user = auth.currentUser;
    if (!user || mfaResolver || screen === SCREENS.ENROLL_2FA) return;
    continueAfterPrimaryLogin(user, false);
  }, [continueAfterPrimaryLogin, mfaResolver, screen]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);

    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      if (rememberMe) localStorage.setItem("rememberEmail", email);
      else localStorage.removeItem("rememberEmail");
      await continueAfterPrimaryLogin(result.user);
    } catch (err) {
      if (err.code === "auth/multi-factor-auth-required") {
        const resolver = getMultiFactorResolver(auth, err);
        const supportedHint =
          resolver.hints.find(
            (hint) => hint.factorId === PhoneMultiFactorGenerator.FACTOR_ID,
          ) ||
          resolver.hints.find(
            (hint) => hint.factorId === TotpMultiFactorGenerator.FACTOR_ID,
          );
        if (!supportedHint) {
          setError(t("unsupportedSecondFactor"));
        } else {
          setMfaResolver({ resolver, hint: supportedHint });
          setScreen(SCREENS.VERIFY_2FA);
        }
      } else {
        console.error(err);
        setError(t("loginError"));
      }
    } finally {
      setBusy(false);
    }
  };

  const checkEmailVerification = async () => {
    setBusy(true);
    setError("");
    try {
      await auth.currentUser?.reload();
      const user = auth.currentUser;
      if (!user?.emailVerified) {
        setNotice(t("emailStillNotVerified"));
        return;
      }
      setNotice(
        t(authPolicy.requireMfa ? "emailVerified" : "emailVerifiedNoMfa"),
      );
      await continueAfterPrimaryLogin(user, false);
    } catch (err) {
      console.error(err);
      setError(t("verificationCheckError"));
    } finally {
      setBusy(false);
    }
  };

  const resendVerification = async () => {
    setBusy(true);
    setError("");
    try {
      await sendVerification(auth.currentUser);
    } catch (err) {
      console.error(err);
      setError(verificationErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const sendEnrollmentCode = async (event) => {
    event.preventDefault();
    if (!enrollmentSession) return;
    setBusy(true);
    setError("");
    try {
      const provider = new PhoneAuthProvider(auth);
      const verificationId = await provider.verifyPhoneNumber(
        {
          phoneNumber: normalizePhoneNumber(phoneNumber),
          session: enrollmentSession,
        },
        getRecaptchaVerifier(),
      );
      setPhoneVerificationId(verificationId);
      setNotice(t("smsCodeSent"));
    } catch (err) {
      console.error(err);
      recaptchaVerifierRef.current?.clear();
      recaptchaVerifierRef.current = null;
      setError(enrollmentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const enrollSecondFactor = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const credential = PhoneAuthProvider.credential(
        phoneVerificationId,
        verificationCode.trim(),
      );
      const assertion = PhoneMultiFactorGenerator.assertion(credential);
      await multiFactor(auth.currentUser).enroll(
        assertion,
        t("smsDisplayName"),
      );
      setNotice(t("twoFactorEnabled"));
      navigate(home);
    } catch (err) {
      console.error(err);
      setError(t("invalidTwoFactorCode"));
    } finally {
      setBusy(false);
    }
  };

  const sendPhoneSignInChallenge = useCallback(async () => {
    if (!mfaResolver || phoneChallengeStartedRef.current) return;
    phoneChallengeStartedRef.current = true;
    setBusy(true);
    setError("");
    try {
      const provider = new PhoneAuthProvider(auth);
      const verificationId = await provider.verifyPhoneNumber(
        {
          multiFactorHint: mfaResolver.hint,
          session: mfaResolver.resolver.session,
        },
        getRecaptchaVerifier(),
      );
      setPhoneVerificationId(verificationId);
      setNotice(
        t("smsCodeSentMasked", { phone: mfaResolver.hint.phoneNumber || "" }),
      );
    } catch (err) {
      console.error(err);
      phoneChallengeStartedRef.current = false;
      recaptchaVerifierRef.current?.clear();
      recaptchaVerifierRef.current = null;
      setError(enrollmentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [enrollmentErrorMessage, getRecaptchaVerifier, mfaResolver, t]);

  useEffect(() => {
    if (
      screen === SCREENS.VERIFY_2FA &&
      mfaResolver?.hint.factorId === PhoneMultiFactorGenerator.FACTOR_ID
    ) {
      sendPhoneSignInChallenge();
    }
  }, [mfaResolver, screen, sendPhoneSignInChallenge]);

  const resolveSecondFactor = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const assertion =
        mfaResolver.hint.factorId === PhoneMultiFactorGenerator.FACTOR_ID
          ? PhoneMultiFactorGenerator.assertion(
              PhoneAuthProvider.credential(
                phoneVerificationId,
                verificationCode.trim(),
              ),
            )
          : TotpMultiFactorGenerator.assertionForSignIn(
              mfaResolver.hint.uid,
              verificationCode.trim(),
            );
      const result = await mfaResolver.resolver.resolveSignIn(assertion);
      if (!result.user.emailVerified) {
        await continueAfterPrimaryLogin(result.user);
      } else {
        navigate(home);
      }
    } catch (err) {
      console.error(err);
      setError(t("invalidTwoFactorCode"));
    } finally {
      setBusy(false);
    }
  };

  const resetLogin = async () => {
    if (auth.currentUser) await signOut(auth);
    setScreen(SCREENS.LOGIN);
    setMfaResolver(null);
    setPhoneVerificationId("");
    setEnrollmentSession(null);
    phoneChallengeStartedRef.current = false;
    recaptchaVerifierRef.current?.clear();
    recaptchaVerifierRef.current = null;
    setVerificationCode("");
    setError("");
    setNotice("");
  };

  const codeForm = (onSubmit, buttonLabel) => (
    <form onSubmit={onSubmit} className="space-y-4">
      <label
        className="block text-sm font-medium text-gray-700"
        htmlFor="verification-code"
      >
        {t("twoFactorCode")}
      </label>
      <input
        id="verification-code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        value={verificationCode}
        onChange={(event) =>
          setVerificationCode(event.target.value.replace(/\D/g, ""))
        }
        placeholder="123456"
        required
        className="w-full px-4 py-2 text-center text-xl tracking-[0.35em] border border-gray-300 rounded focus:outline-none focus:ring focus:border-brand-800"
      />
      <button
        disabled={busy}
        type="submit"
        className="w-full bg-brand-800 disabled:opacity-60 text-white py-2 rounded hover:bg-brand-950 transition"
      >
        {busy ? t("processing") : buttonLabel}
      </button>
    </form>
  );

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <header className="ht-public-header">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-5 py-5 sm:px-8">
          <Brand />
          <button
            type="button"
            onClick={() => navigate("/")}
            className="ht-button-secondary"
          >
            {t("back")}
          </button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-grow items-center gap-12 px-5 py-10 sm:px-8 lg:grid-cols-2 lg:py-16">
        <aside className="hidden lg:block">
          <p className="ht-eyebrow">Your hotel workspace</p>
          <h2 className="mt-5 max-w-md font-display text-5xl leading-tight tracking-tight text-brand-950">
            A clearer day.
            <br />A connected team.
          </h2>
          <p className="mt-6 max-w-sm text-sm leading-7 text-gray-600">
            Bring purchasing, groups, revenue and daily operations into the same
            workspace.
          </p>
          <div className="mt-8 max-w-sm space-y-4">
            {[
              [Layers, "The modules your hotel uses"],
              [Users, "The access your team needs"],
              [ShieldCheck, "Your hotel's own workspace"],
            ].map(([Icon, label]) => (
              <p
                key={label}
                className="flex flex-wrap items-center gap-3 text-sm text-gray-600"
              >
                <span className="rounded-lg border border-gray-200 bg-white p-2.5">
                  <Icon
                    size={17}
                    className="text-brand-700"
                    aria-hidden="true"
                  />
                </span>
                {label}
              </p>
            ))}
          </div>
        </aside>
        <div className="ht-panel mx-auto w-full max-w-md p-6 shadow-lifted sm:p-8">
          <div className="flex flex-col items-center mb-6">
            <span className="ht-eyebrow mb-3">Welcome to Hotel Toolkit</span>
            <h1 className="font-display text-3xl tracking-tight text-brand-950">
              {t(screen === SCREENS.LOGIN ? "loginTitle" : `${screen}Title`)}
            </h1>
            <p className="text-gray-600 text-sm mt-1 text-center">
              {t(
                screen === SCREENS.LOGIN
                  ? "loginSubtitle"
                  : `${screen}Subtitle`,
              )}
            </p>
          </div>

          {error && (
            <p
              role="alert"
              className="mb-4 rounded bg-red-50 p-3 text-red-700 text-sm"
            >
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="mb-4 rounded bg-blue-50 p-3 text-blue-800 text-sm"
            >
              {notice}
            </p>
          )}

          <div
            id="recaptcha-container"
            role="group"
            className="mb-4 flex min-h-0 justify-center"
            aria-label={t("smsSecurityCheck")}
          />

          {screen === SCREENS.LOGIN && (
            <form onSubmit={handleLogin} className="space-y-4">
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("email")}
                aria-label={t("email")}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring focus:border-brand-800"
              />
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("password")}
                aria-label={t("password")}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring focus:border-brand-800"
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
                disabled={busy}
                type="submit"
                className="w-full bg-brand-800 disabled:opacity-60 text-white py-2 rounded hover:bg-brand-950 transition"
              >
                {busy ? t("processing") : t("loginButton")}
              </button>
            </form>
          )}

          {screen === SCREENS.VERIFY_EMAIL && (
            <div className="space-y-3">
              <button
                disabled={busy}
                onClick={checkEmailVerification}
                className="w-full bg-brand-800 disabled:opacity-60 text-white py-2 rounded hover:bg-brand-950"
              >
                {t("checkVerification")}
              </button>
              <button
                disabled={busy || resendCooldown > 0}
                onClick={resendVerification}
                className="w-full border border-brand-800 disabled:cursor-not-allowed disabled:opacity-60 text-brand-800 py-2 rounded hover:bg-brand-50"
              >
                {resendCooldown > 0
                  ? t("resendVerificationCountdown", {
                      seconds: resendCooldown,
                    })
                  : t("resendVerification")}
              </button>
            </div>
          )}

          {screen === SCREENS.ENROLL_2FA && (
            <div>
              {busy && (
                <p className="text-center text-sm text-gray-600">
                  {t("preparingTwoFactor")}
                </p>
              )}
              {!busy && enrollmentSession && !phoneVerificationId && (
                <form onSubmit={sendEnrollmentCode} className="space-y-4">
                  <label
                    htmlFor="phone-number"
                    className="block text-sm font-medium text-gray-700"
                  >
                    {t("phoneNumber")}
                  </label>
                  <input
                    id="phone-number"
                    type="tel"
                    autoComplete="tel"
                    value={phoneNumber}
                    onChange={(event) => setPhoneNumber(event.target.value)}
                    placeholder="+32 470 00 00 00"
                    required
                    pattern="^[+][1-9][0-9 ]{7,20}$"
                    className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring focus:border-brand-800"
                  />
                  <p className="text-xs text-gray-500">
                    {t("phoneNumberHelp")}
                  </p>
                  <button
                    disabled={busy}
                    type="submit"
                    className="w-full bg-brand-800 text-white py-2 rounded hover:bg-brand-950"
                  >
                    {t("sendSmsCode")}
                  </button>
                </form>
              )}
              {!busy &&
                enrollmentSession &&
                phoneVerificationId &&
                codeForm(enrollSecondFactor, t("enableTwoFactor"))}
              {!busy && !enrollmentSession && (
                <button
                  onClick={() => startEnrollment(auth.currentUser)}
                  className="w-full border border-brand-800 text-brand-800 py-2 rounded hover:bg-brand-50"
                >
                  {t("retryTwoFactorSetup")}
                </button>
              )}
            </div>
          )}

          {screen === SCREENS.VERIFY_2FA && (
            <>
              {busy && (
                <p className="text-center text-sm text-gray-600">
                  {t("sendingSmsCode")}
                </p>
              )}
              {!busy &&
                (mfaResolver?.hint.factorId !==
                  PhoneMultiFactorGenerator.FACTOR_ID ||
                  phoneVerificationId) &&
                codeForm(resolveSecondFactor, t("verifyAndLogin"))}
              {!busy &&
                mfaResolver?.hint.factorId ===
                  PhoneMultiFactorGenerator.FACTOR_ID &&
                !phoneVerificationId && (
                  <button
                    onClick={sendPhoneSignInChallenge}
                    className="w-full border border-brand-800 text-brand-800 py-2 rounded"
                  >
                    {t("retrySmsCode")}
                  </button>
                )}
            </>
          )}

          {screen !== SCREENS.LOGIN && (
            <button
              disabled={busy}
              onClick={resetLogin}
              className="mt-5 w-full text-sm text-gray-500 hover:text-brand-800"
            >
              {t("useAnotherAccount")}
            </button>
          )}
          <p className="text-xs text-center text-gray-500 mt-6">
            &copy; {new Date().getFullYear()} Hotel Toolkit
          </p>
        </div>
      </div>
    </div>
  );
}
