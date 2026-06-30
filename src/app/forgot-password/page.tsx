import type { Metadata } from "next";
import { AuthFlow } from "../(auth)/auth-flow";

export const metadata: Metadata = {
  title: "重置密码 | EchoLens",
};

export default function ForgotPasswordPage() {
  return <AuthFlow mode="forgot" />;
}
