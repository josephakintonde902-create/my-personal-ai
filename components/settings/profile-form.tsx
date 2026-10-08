"use client";

import { useActionState, useRef, useState, useTransition, type ChangeEvent } from "react";
import { removeAvatar, saveAvatar, updateProfile, type ProfileFormState } from "@/app/(app)/settings/actions";
import { UserAvatar } from "@/components/account-menu";
import { useAuth } from "@/components/auth/auth-provider";
import { FormMessage, SubmitButton, TextField } from "@/components/auth/form-fields";
import { BIO_MAX_LENGTH, FULL_NAME_MAX_LENGTH } from "@/lib/auth/validation";
import { AVATAR_BUCKET, AVATAR_MAX_BYTES, AVATAR_TYPES, avatarPath } from "@/lib/profile/avatar";
import { createClient } from "@/lib/supabase/client";

const initialState: ProfileFormState = { status: "idle" };

export function ProfileForm() {
  const { user, profile } = useAuth();
  const [state, action, pending] = useActionState(updateProfile, initialState);
  const [bioLength, setBioLength] = useState(profile?.bio?.length ?? 0);

  if (!profile) {
    return (
      <FormMessage tone="error">
        We couldn&apos;t load your profile. Refresh the page, and sign in again if the problem continues.
      </FormMessage>
    );
  }

  return (
    <>
      <AvatarUploader />

      <form action={action} className="auth-form settings-form" noValidate>
        <TextField
          autoComplete="name"
          defaultValue={profile.full_name ?? ""}
          error={state.fieldErrors?.fullName}
          label="Full name"
          maxLength={FULL_NAME_MAX_LENGTH}
          name="fullName"
          required
        />
        <TextField
          defaultValue={user.email}
          hint="Your email is used to sign in and can't be changed here yet."
          label="Email"
          name="email"
          readOnly
          type="email"
        />
        <div className="field">
          <div className="field-label-row">
            <label htmlFor="profile-bio">Bio</label>
            <span className="field-count">{bioLength}/{BIO_MAX_LENGTH}</span>
          </div>
          <textarea
            aria-describedby={state.fieldErrors?.bio ? "profile-bio-error" : undefined}
            aria-invalid={state.fieldErrors?.bio ? true : undefined}
            className={`field-input field-textarea${state.fieldErrors?.bio ? " has-error" : ""}`}
            defaultValue={profile.bio ?? ""}
            id="profile-bio"
            maxLength={BIO_MAX_LENGTH}
            name="bio"
            onChange={(event) => setBioLength(event.target.value.length)}
            placeholder="What are you studying, and what are you working towards?"
            rows={4}
          />
          {state.fieldErrors?.bio && <p className="field-error" id="profile-bio-error" role="alert">{state.fieldErrors.bio}</p>}
        </div>

        <div className="settings-actions">
          <SubmitButton pending={pending} pendingLabel="Saving…">Save changes</SubmitButton>
          {!pending && state.message && (
            <span className={`save-status ${state.status}`} role={state.status === "error" ? "alert" : "status"}>
              {state.status === "success" && "✓ "}{state.message}
            </span>
          )}
        </div>
      </form>
    </>
  );
}

function AvatarUploader() {
  const { user, profile } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!AVATAR_TYPES.includes(file.type)) {
      setMessage({ tone: "error", text: "Choose a PNG, JPG, or WebP image." });
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setMessage({ tone: "error", text: "Choose an image smaller than 2 MB." });
      return;
    }

    setMessage(null);
    startTransition(async () => {
      const { error: uploadError } = await createClient()
        .storage.from(AVATAR_BUCKET)
        .upload(avatarPath(user.id), file, { upsert: true, contentType: file.type });

      const result = uploadError ? { error: "We couldn't upload that image. Please try again." } : await saveAvatar();
      setMessage(result.error ? { tone: "error", text: result.error } : { tone: "success", text: "Photo updated." });
    });
  };

  const handleRemove = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await removeAvatar();
      setMessage(result.error ? { tone: "error", text: result.error } : { tone: "success", text: "Photo removed." });
    });
  };

  return (
    <div className="avatar-row">
      <UserAvatar size="lg" />
      <div className="avatar-row-copy">
        <strong>Profile photo</strong>
        <span>PNG, JPG, or WebP, up to 2 MB.</span>
        <div className="avatar-row-actions">
          <button aria-busy={pending} className="auth-secondary compact" disabled={pending} onClick={() => fileInput.current?.click()} type="button">
            {pending && <span aria-hidden="true" className="spinner dark" />}
            {pending ? "Working…" : profile?.avatar_url ? "Change photo" : "Upload photo"}
          </button>
          {profile?.avatar_url && !pending && (
            <button className="link-button" onClick={handleRemove} type="button">Remove</button>
          )}
        </div>
        {message && <span className={`save-status ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</span>}
      </div>
      <input
        accept={AVATAR_TYPES.join(",")}
        aria-label="Upload a profile photo"
        className="visually-hidden"
        onChange={handleFile}
        ref={fileInput}
        type="file"
      />
    </div>
  );
}
