import type { Metadata } from "next";
import { AuthFlow } from "../(auth)/auth-flow";

export const metadata: Metadata = {
  title: "注册 | EchoLens",
};

export default function RegisterPage() {
  return <AuthFlow mode="register" />;
}
