export const PASSWORD_MIN_LENGTH = 8;
export const FULL_NAME_MAX_LENGTH = 100;
export const BIO_MAX_LENGTH = 500;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const passwordRules = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (value: string) => value.length >= PASSWORD_MIN_LENGTH },
  { id: "letter", label: "One letter", test: (value: string) => /[A-Za-z]/.test(value) },
  { id: "number", label: "One number", test: (value: string) => /\d/.test(value) },
];

export function validateEmail(email: string) {
  if (!email) return "Enter your email address.";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
  return undefined;
}

export function validatePassword(password: string) {
  if (!password) return "Enter a password.";
  if (password.length > 72) return "Use a password of 72 characters or fewer.";
  if (passwordRules.some((rule) => !rule.test(password))) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters, including a letter and a number.`;
  }
  return undefined;
}

export function validateConfirmPassword(password: string, confirmPassword: string) {
  if (!confirmPassword) return "Confirm your password.";
  if (password !== confirmPassword) return "Passwords do not match.";
  return undefined;
}

export function validateFullName(fullName: string) {
  if (!fullName) return "Enter your full name.";
  if (fullName.length > FULL_NAME_MAX_LENGTH) return `Use ${FULL_NAME_MAX_LENGTH} characters or fewer.`;
  return undefined;
}

export function validateBio(bio: string) {
  if (bio.length > BIO_MAX_LENGTH) return `Use ${BIO_MAX_LENGTH} characters or fewer.`;
  return undefined;
}

export function formText(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// Passwords are never trimmed: leading/trailing spaces are part of the secret.
export function formPassword(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
