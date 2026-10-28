// Facts shared by every page. The version comes from the extension itself, so the
// site never states a version that was not released.
import extensionPkg from "../../../package.json";

export const extensionVersion: string = extensionPkg.version;
export const repoUrl = "https://github.com/rheav/socialmate-pub";
/** Where the "install" buttons lead: the latest release's zip. */
export const downloadUrl = `${repoUrl}/releases/latest`;
export const supportEmail = "rheav7@gmail.com";
