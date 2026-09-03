import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

const authMocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  sendEmailVerification: vi.fn(),
  multiFactor: vi.fn(),
  generateSecret: vi.fn(),
}));

vi.mock("../../firebaseConfig", () => ({
  auth: { currentUser: null },
  signInWithEmailAndPassword: authMocks.signIn,
}));

vi.mock("firebase/auth", () => ({
  getMultiFactorResolver: vi.fn(),
  multiFactor: authMocks.multiFactor,
  sendEmailVerification: authMocks.sendEmailVerification,
  signOut: vi.fn(),
  TotpMultiFactorGenerator: {
    FACTOR_ID: "totp",
    generateSecret: authMocks.generateSecret,
    assertionForEnrollment: vi.fn(),
    assertionForSignIn: vi.fn(),
  },
}));

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(() => "data:image/png;base64,qr") } }));
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

  it("starts TOTP enrollment for a verified user without a second factor", async () => {
    const user = {
      email: "user@example.com",
      emailVerified: true,
      reload: vi.fn().mockResolvedValue(),
      getIdToken: vi.fn().mockResolvedValue("fresh-token"),
    };
    const getSession = vi.fn().mockResolvedValue("mfa-session");
    authMocks.multiFactor.mockReturnValue({ enrolledFactors: [], getSession });
    authMocks.generateSecret.mockResolvedValue({
      secretKey: "MANUAL-SECRET",
      generateQrCodeUrl: vi.fn(() => "otpauth://totp/example"),
    });
    authMocks.signIn.mockResolvedValue({ user });

    render(<LoginPage />);
    submitCredentials();

    expect(await screen.findByText("enroll-2faTitle")).toBeInTheDocument();
    expect(screen.getByText("MANUAL-SECRET")).toBeInTheDocument();
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(authMocks.generateSecret).toHaveBeenCalledWith("mfa-session");
    expect(user.getIdToken).toHaveBeenCalledWith(true);
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

  it("explains when TOTP is not enabled in the Firebase project", async () => {
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
});
