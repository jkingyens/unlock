# Unlock: Reprogramming the Web

Unlock is a Chrome extension that reimagines the web as an interactive, programmable environment. It moves beyond passive consumption, transforming the web from a surface for *reading* into a surface for *doing*.

With Unlock, you can create "packets" that bundle public webpages with your own private documents, media, and interactive elements. This creates self-contained experiences for accomplishing tasks, completing projects, or exploring topics in depth. The extension serves as the runtime for these packets and is a prototype for upcoming native mobile applications.

---

### Core Features

* **From Content to Experiences**: Shift from merely browsing content to engaging with structured, task-oriented experiences.
* **Private Realms**: Seamlessly blend public web content with your own private notes, media, and generated pages.
* **A New Container Format**: Think of Unlock packets as a container for the web, treating HTML, audio, and PDFs as native components of a larger experience.
* **Powerful Tooling**: A command-line interface (`pkt`) allows for the creation, validation, and publication of packets.

---

### Getting Started

#### CLI Setup

To use the `pkt` command-line tool for managing your packets, follow these installation steps.

**1. Install the Command**

To avoid potential permission issues, we recommend configuring `npm` to use a local directory for global packages.

First, create the directory and configure `npm`:
```shell
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
```

Next, add the new directory to your shell's `PATH` (e.g., in `~/.zshrc`, `~/.bash_profile`, or `~/.bashrc`):
```shell
export PATH=~/.npm-global/bin:$PATH
```

Finally, open a new terminal and run `npm link` from the project's root directory:
```shell
npm link
```
The `pkt` command will now be available globally in your terminal.

**2. Create Your Config File**

With the CLI installed, generate the configuration file in your home directory:
```shell
pkt config
```
This creates a file at `~/.unlockrc`. You must edit this file to add your cloud storage and LLM API keys.

**3. Test Your Credentials**

After editing your config file, verify that your credentials and settings are correct:
```shell
pkt test-creds
```

#### Loading the Extension

To run the extension locally, you'll need to load it as an unpacked extension in a Chromium-based browser (e.g., Google Chrome, Arc, Brave).

1.  Navigate to `chrome://extensions` in your browser.
2.  Enable **Developer mode** using the toggle switch.
3.  Click the **Load unpacked** button.
4.  In the file dialog, navigate to your project and select the `ext` folder.

The Unlock extension will now appear in your list of extensions. To apply any code changes you make, simply click the "Reload" icon on the extension's card.

---
*Connect with the creator on Bluesky: [@jkingyens.bsky.social](https://bsky.app/profile/jkingyens.bsky.social)*