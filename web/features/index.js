import { createMailTools } from "./mail.js";
import { createAccountTools } from "./account.js";
import { createContacts } from "./contacts.js";
import { createPhotoTools } from "./photos.js";
import { createOffline } from "./offline.js";
import { createResourceTools } from "./resources.js";
export function createFeatures(context) {
  function section(id, label) {
    const root = document.createElement("section"); root.className = "settings-sec"; root.dataset.sec = id; root.hidden = true; document.querySelector("#tab-instellingen").append(root);
    const link = document.createElement("a"); link.href = `#instellingen/${id}`; link.dataset.sec = id; link.textContent = label; document.querySelector("#settingsNav").append(link); return root;
  }
  const mail = createMailTools({ ...context, reload: context.reloadMail });
  const account = createAccountTools({ ...context, section }), resources = createResourceTools({ ...context, section });
  const contacts = createContacts(context), photos = createPhotoTools(context), offline = createOffline({ ...context, section });
  return { composer: mail.open, contacts: contacts.load, photos,
    boot: () => offline.start().catch(() => {}), clearOffline: offline.clear,
    settings: (name) => { account.show(name); offline.show(name); resources.show(name); },
  };
}
