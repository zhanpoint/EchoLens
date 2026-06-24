import type { Metadata } from "next";
import { AuthFlow } from "../auth-flow";

export const metadata: Metadata = {
  title: "登录 | EchoLens",
};

export default function LoginPage() {
  return <AuthFlow mode="login" />;
}
