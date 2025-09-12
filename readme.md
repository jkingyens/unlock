# Unlock

Unlock is a Chrome extension to unlock the web. It fundamentally transforms the web from being a sea of content "out there" that you merely consume into a programmable system for building experiences to completing tasks and get shit done. It shifts the nature of the web as a surface for reading into a surface for doing. It expands the web from a repository of public documents to include your own private realms that reference a mix of extenral public pages and internal documents only accessible to you. Think of this like a container format but for end users. While HTML is a core piece of this, it treats media files like audio and pdf files as native types. All of these types and more get bundled into packets. We have a CLI for creating, manipulating and publishing them. The focus of the chrome extension is for executing packets as the end user. This extension also serves as a working prototype for mobile native applications we are buiding next.

[@jkingyens.bsky.social](https://bsky.app/profile/jkingyens.bsky.social)

---

## CLI Setup

To use the command-line tool (`pkt`) for validating and exporting packets, follow these steps.

1. Install the Command

The recommended way to install the CLI is to configure npm to use a local directory, which avoids all permission issues.

First, create a directory for global packages and configure npm to use it:

```
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
```

Next, add this new directory to your shell's configuration file (e.g., ~/.zshrc, ~/.bash_profile, or ~/.bashrc):

```
export PATH=~/.npm-global/bin:$PATH
```

Finally, open a new terminal and, from the project's root directory, run:

```
npm link
```

The pkt command should now be available everywhere.

2. Create Your Config File

Once the pkt command is installed, create the configuration file in your home directory:

```
pkt config
```

This will create a file at ~/.unlockrc. You must edit this file to add your cloud storage and LLM API keys.

3. Test Your Credentials

After editing the config file, you can verify that your keys and settings are correct by running:

```
pkt test-creds
```

Loading the Extension

To test the extension, you need to load it as an unpacked extension in a Chromium-based browser (like Google Chrome, Arc, or Brave).

Navigate to chrome://extensions in your browser.

Enable "Developer mode" using the toggle switch, which is usually in the top-right corner.

Click the "Load unpacked" button that appears.

In the file selection dialog, navigate to your project directory and select the ext folder.

The "Unlock" extension should now appear in your list of extensions. As you make changes to the code, you can click the "Reload" icon on the extension's card to apply them.