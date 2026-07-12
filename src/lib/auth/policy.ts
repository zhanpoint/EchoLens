const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{3,24}$/u;

export type PasswordValidation = {
  errors: string[];
  valid: boolean;
};

export function getEmailError(value: string): string | undefined {
  const email = value.trim();
  if (!email) {
    return "请输入邮箱。";
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return "请输入有效邮箱地址。";
  }
}

export function getUsernameError(value: string): string | undefined {
  const username = value.trim();
  if (!username) {
    return "请输入用户名。";
  }
  if (!USERNAME_PATTERN.test(username)) {
    return "用户名需为 3 到 24 位，可包含中文、字母、数字、下划线或短横线。";
  }
}

export function getPasswordError(password: string): string | undefined {
  return validatePassword(password).errors[0];
}

export function validatePassword(password: string): PasswordValidation {
  const errors: string[] = [];
  if (!password) {
    errors.push("请输入密码。");
  } else if (password.length < 8) {
    errors.push("密码至少需要 8 个字符。");
  }
  if (password.length > 128) {
    errors.push("密码不能超过 128 个字符。");
  }

  const typeCount = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  if (password && typeCount < 3) {
    errors.push("密码需包含大写字母、小写字母、数字、特殊字符中的至少 3 种。");
  }

  return { errors, valid: errors.length === 0 };
}
