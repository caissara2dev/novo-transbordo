import type { Auth } from "firebase/auth";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signOut,
  updateProfile
} from "firebase/auth";

export async function registerAccount({
  auth,
  email,
  name,
  password
}: {
  auth: Auth;
  email: string;
  name: string;
  password: string;
}): Promise<string> {
  const normalizedEmail = email.trim();
  const displayName = name.trim();
  let accountCreated = false;

  try {
    const credentials = await createUserWithEmailAndPassword(
      auth,
      normalizedEmail,
      password
    );
    accountCreated = true;

    if (displayName) {
      await updateProfile(credentials.user, { displayName });
    }

    await sendEmailVerification(credentials.user);
    return credentials.user.email || normalizedEmail;
  } finally {
    if (accountCreated) {
      await signOut(auth);
    }
  }
}
