import type { AddonCustomization } from "../api.js";
import { filledClass, Notice } from "./ui.js";

export function HeroPanel({
  addonName,
  addonDescription,
  addonLogoUrl,
  customizationMessage,
  editingName,
  editingDescription,
  editingLogo,
  defaultCustomization,
  onAddonNameChange,
  onAddonDescriptionChange,
  onAddonLogoUrlChange,
  onEditName,
  onEditDescription,
  onStopEditingName,
  onStopEditingDescription,
  onStopEditingLogo,
  onCommitName,
  onCommitDescription,
  onCommitLogo,
}: {
  addonName: string;
  addonDescription: string;
  addonLogoUrl: string;
  customizationMessage: string;
  editingName: boolean;
  editingDescription: boolean;
  editingLogo: boolean;
  defaultCustomization: AddonCustomization;
  onAddonNameChange: (value: string) => void;
  onAddonDescriptionChange: (value: string) => void;
  onAddonLogoUrlChange: (value: string) => void;
  onEditName: () => void;
  onEditDescription: () => void;
  onStopEditingName: () => void;
  onStopEditingDescription: () => void;
  onStopEditingLogo: () => void;
  onCommitName: () => void;
  onCommitDescription: () => void;
  onCommitLogo: () => void;
}) {
  return (
    <section className="hero">
      <span className="section-label">Private source addon</span>
      {editingName ? (
        <input
          className={filledClass(addonName, "hero-title-input")}
          aria-label="Addon name"
          value={addonName}
          autoFocus={true}
          maxLength={80}
          onChange={(event) => onAddonNameChange(event.currentTarget.value)}
          onBlur={onCommitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              onAddonNameChange(addonName.trim() || defaultCustomization.addonName);
              onStopEditingName();
            }
          }}
        />
      ) : (
        <button type="button" className="editable-title" aria-label="Edit addon name" onClick={onEditName}>
          <h1>{addonName}</h1>
        </button>
      )}
      {editingDescription ? (
        <textarea
          className={filledClass(addonDescription, "hero-description-input")}
          aria-label="Addon description"
          value={addonDescription}
          autoFocus={true}
          maxLength={260}
          rows={3}
          onChange={(event) => onAddonDescriptionChange(event.currentTarget.value)}
          onBlur={onCommitDescription}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              onAddonDescriptionChange(addonDescription.trim() || defaultCustomization.addonDescription);
              onStopEditingDescription();
            }
          }}
        />
      ) : (
        <button type="button" className="editable-description" aria-label="Edit addon description" onClick={onEditDescription}>
          <p>{addonDescription}</p>
        </button>
      )}
      <Notice className="customization-notice">{customizationMessage}</Notice>
      {editingLogo ? (
        <div className="avatar-editor">
          <label htmlFor="addonLogoUrl">Addon avatar URL</label>
          <input
            id="addonLogoUrl"
            className={filledClass(addonLogoUrl)}
            value={addonLogoUrl}
            autoFocus={true}
            placeholder="https://example.com/logo.png"
            onChange={(event) => onAddonLogoUrlChange(event.currentTarget.value)}
            onBlur={onCommitLogo}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") onStopEditingLogo();
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
