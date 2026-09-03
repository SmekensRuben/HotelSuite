import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

const authMocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  sendEmailVerification: vi.fn(),
  multiFactor: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  phoneCredential: vi.fn(),
  phoneAssertion: vi.fn(),
  recaptchaConstructor: vi.fn(),
  recaptchaClear: vi.fn(),
  getMultiFactorResolver: vi.fn(),
}));

vi.mock("../../firebaseConfig", () => ({
  auth: { currentUser: null },
  signInWithEmailAndPassword: authMocks.signIn,
}));

vi.mock("firebase/auth", () => ({
  getMultiFactorResolver: authMocks.getMultiFactorResolver,
  multiFactor: authMocks.multiFactor,
  sendEmailVerification: authMocks.sendEmailVerification,
  signOut: vi.fn(),
  PhoneAuthProvider: class PhoneAuthProvider {
    verifyPhoneNumber(...args) { return authMocks.verifyPhoneNumber(...args); }
    static credential(...args) { return authMocks.phoneCredential(...args); }
  },
  PhoneMultiFactorGenerator: {
    FACTOR_ID: "phone",
    assertion: authMocks.phoneAssertion,
  },
  RecaptchaVerifier: class RecaptchaVerifier {
    constructor(...args) { authMocks.recaptchaConstructor(...args); }
    clear() { authMocks.recaptchaClear(); }
  },
  TotpMultiFactorGenerator: {
    FACTOR_ID: "totp",
    assertionForSignIn: vi.fn(),
  },
}));

vi.mock("framer-motion", () => ({ motion: { div: ({ children, ...props }) => <div {...props}>{children}</div> } }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../contexts/HotelContext", () => ({ useHotelContext: () => ({ hotelUid: null, loading: false }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));

const submitCredentials = () => {
  fireEvent.change(screen.getByPlaceholderText("email"), { target: { value: "user@example.com" } });
  fireEvent.change(screen.getByPlaceholderText("password"), { target: { value: "secret123" } });
  fireEvent.click(screen.getByRole("button", { name: "loginButton" }));
};

describe("LoginPage authentication steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authMocks.sendEmailVerification.mockResolvedValue();
  });

  it("shows the email verification screen and sends a verification email", async () => {
    const user = { email: "user@example.com", emailVerified: false };
    authMocks.signIn.mockResolvedValue({ user });

    render(<LoginPage />);
    submitCredentials();

    expect(await screen.findByText("verify-emailTitle")).toBeInTheDocument();
    expect(screen.getByText("verificationEmailSent")).toBeInTheDocument();
    expect(authMocks.sendEmailVerification).toHaveBeenCalledWith(user);
  });

  it("starts SMS enrollment for a verified user without a second factor", async () => {
    const user = {
      email: "user@example.com",
      emailVerified: true,
      reload: vi.fn().mockResolvedValue(),
      getIdToken: vi.fn().mockResolvedValue("fresh-token"),
    };
    const getSession = vi.fn().mockResolvedValue("mfa-session");
    const enroll = vi.fn().mockResolvedValue();
    authMocks.multiFactor.mockReturnValue({ enrolledFactors: [], getSession, enroll });
    authMocks.verifyPhoneNumber.mockResolvedValue("verification-id");
    authMocks.phoneCredential.mockReturnValue("phone-credential");
    authMocks.phoneAssertion.mockReturnValue("phone-assertion");
    authMocks.signIn.mockResolvedValue({ user });

    render(<LoginPage />);
    submitCredentials();

    expect(await screen.findByText("enroll-2faTitle")).toBeInTheDocument();
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(user.getIdToken).toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByLabelText("phoneNumber"), { target: { value: "+32497152743" } });
    fireEvent.click(screen.getByRole("button", { name: "sendSmsCode" }));
    expect(await screen.findByText("smsCodeSent")).toBeInTheDocument();
    expect(authMocks.verifyPhoneNumber).toHaveBeenCalledWith(
      { phoneNumber: "+32497152743", session: "mfa-session" },
      expect.anything(),
    );
    expect(authMocks.recaptchaConstructor).toHaveBeenCalledWith(
      "recaptcha-container",
      { size: "normal" },
      expect.anything(),
    );
  });

  it("shows the actionable Firebase error when verification email requests are throttled", async () => {
    const user = { uid: "user-1", email: "user@example.com", emailVerified: false };
    authMocks.signIn.mockResolvedValue({ user });
    authMocks.sendEmailVerification.mockRejectedValue({ code: "auth/too-many-requests" });

    render(<LoginPage />);
    submitCredentials();

    expect(await screen.findByText("verificationTooManyRequests")).toBeInTheDocument();
    expect(screen.getByText("emailNotVerified")).toBeInTheDocument();
  });

  it("does not request another email during the resend cooldown", async () => {
    const user = { uid: "user-1", email: "user@example.com", emailVerified: false };
    authMocks.signIn.mockResolvedValue({ user });
    localStorage.setItem("verificationEmailSentAt:user-1", String(Date.now()));

    render(<LoginPage />);
    submitCredentials();

    expect(await screen.findByText("verificationEmailAlreadySent")).toBeInTheDocument();
    expect(authMocks.sendEmailVerification).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /resendVerificationCountdown/ })).toBeDisabled();
  });

  it("explains when MFA is not enabled in the Firebase project", async () => {
    const user = {
      email: "user@example.com",
      emailVerified: true,
      reload: vi.fn().mockResolvedValue(),
      getIdToken: vi.fn().mockResolvedValue("fresh-token"),
    };
    authMocks.multiFactor.mockReturnValue({
      enrolledFactors: [],
      getSession: vi.fn().mockRejectedValue({ code: "auth/operation-not-allowed" }),
    });
    authMocks.signIn.mockResolvedValue({ user });

    render(<LoginPage />);
    submitCredentials();

    expect(await screen.findByText("twoFactorNotEnabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "retryTwoFactorSetup" })).toBeInTheDocument();
  });

  it("sends an SMS challenge for an existing Firebase phone factor", async () => {
    const authError = { code: "auth/multi-factor-auth-required" };
    const hint = { uid: "phone-factor", factorId: "phone", phoneNumber: "+32******743" };
    const resolver = { hints: [hint], session: "sign-in-session", resolveSignIn: vi.fn() };
    authMocks.signIn.mockRejectedValue(authError);
    authMocks.getMultiFactorResolver.mockReturnValue(resolver);
    authMocks.verifyPhoneNumber.mockResolvedValue("verification-id");

    render(<LoginPage />);
    submitCredentials();

    expect(await screen.findByText("smsCodeSentMasked")).toBeInTheDocument();
    expect(authMocks.verifyPhoneNumber).toHaveBeenCalledWith(
      { multiFactorHint: hint, session: "sign-in-session" },
      expect.anything(),
    );
    expect(screen.getByLabelText("twoFactorCode")).toBeInTheDocument();
  });
});
