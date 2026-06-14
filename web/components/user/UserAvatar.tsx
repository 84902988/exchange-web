"use client";

import React from "react";
import { useLocaleContext } from "@/contexts/LocaleContext";
import { getUserAvatarInitial, getUserAvatarUrl } from "@/lib/userAvatar";

type UserAvatarProps = {
  user?: Parameters<typeof getUserAvatarUrl>[0];
  src?: string | null;
  initial?: string;
  alt?: string;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
  onImageError?: () => void;
};

export default function UserAvatar({
  user,
  src,
  initial,
  alt,
  className = "h-10 w-10",
  imageClassName = "",
  fallbackClassName = "",
  onImageError,
}: UserAvatarProps) {
  const { t } = useLocaleContext();
  const [failedSrc, setFailedSrc] = React.useState("");
  const [loadedSrc, setLoadedSrc] = React.useState("");
  const avatarUrl = (src || getUserAvatarUrl(user)).trim();
  const showImage = avatarUrl && failedSrc !== avatarUrl;
  const letter = initial || getUserAvatarInitial(user);
  const resolvedAlt = alt || t("userAvatarAlt", "user");

  React.useEffect(() => {
    if (avatarUrl && failedSrc && failedSrc !== avatarUrl) {
      setFailedSrc("");
    }
  }, [avatarUrl, failedSrc]);

  React.useEffect(() => {
    if (loadedSrc && loadedSrc !== avatarUrl) {
      setLoadedSrc("");
    }
  }, [avatarUrl, loadedSrc]);

  return (
    <div className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-white/10 ${className}`}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={resolvedAlt}
          className={`h-full w-full object-cover transition-opacity duration-150 ${
            loadedSrc === avatarUrl ? "opacity-100" : "opacity-0"
          } ${imageClassName}`}
          onLoad={() => setLoadedSrc(avatarUrl)}
          onError={() => {
            setFailedSrc(avatarUrl);
            onImageError?.();
          }}
        />
      ) : (
        <div className={`font-semibold text-white/70 ${fallbackClassName}`}>{letter}</div>
      )}
    </div>
  );
}
