import { createHash } from 'node:crypto';
import { validEmail } from './leads.mjs';

function serviceDetails(category) {
  const c = category.toLowerCase();
  if (/roof/.test(c)) return { service: 'roofing', benefit: 'show completed roofing jobs, explain your services, and help homeowners contact you with confidence' };
  if (/fence/.test(c)) return { service: 'fencing', benefit: 'show fence styles and completed installations, share customer testimonials, and make your contact details easy to find' };
  if (/flooring store/.test(c)) return { service: 'flooring products', benefit: 'show your flooring range and material options, share customer feedback, and make your showroom and contact details easy to find' };
  if (/floor|tile/.test(c)) return { service: 'flooring', benefit: 'show flooring options and finished projects, share customer feedback, and help customers see the quality of your work' };
  if (/deck/.test(c)) return { service: 'deck building', benefit: 'show completed decks, explain the materials and styles you work with, and share customer testimonials' };
  if (/landscape designer/.test(c)) return { service: 'landscape design', benefit: 'show garden designs and completed outdoor projects, explain your design services, and share customer testimonials' };
  if (/landscape|landscaper/.test(c)) return { service: 'landscaping', benefit: 'show garden transformations and completed outdoor projects, explain your services, and share customer testimonials' };
  if (/bathroom/.test(c)) return { service: 'bathroom remodeling', benefit: 'show before-and-after bathroom projects, explain your services, and share customer testimonials' };
  if (/kitchen/.test(c)) return { service: 'kitchen remodeling', benefit: 'show finished kitchens, explain the work you offer, and share customer testimonials' };
  if (/concrete product supplier/.test(c)) return { service: 'concrete products', benefit: 'show your product range and example applications, share customer testimonials, and make your contact details easy to find' };
  if (/concrete/.test(c)) return { service: 'concrete work', benefit: 'show completed concrete projects, explain your services, and help customers find your contact details' };
  if (/remodel/.test(c)) return { service: 'remodeling', benefit: 'show before-and-after projects, explain your services, and share customer testimonials' };
  return { service: 'construction and contracting', benefit: 'show completed projects, explain your services, and share customer testimonials' };
}

export function validateSender(sender, { requirePostalAddress = true } = {}) {
  if (!sender || !sender.name || /[\r\n\u0000-\u001f]/.test(sender.name) || !validEmail(sender.email)) throw new Error('Sender name or email is missing or invalid.');
  if (sender.email !== 'craftedwebstudio@gmail.com') throw new Error('This pilot is configured for craftedwebstudio@gmail.com; update the workflow deliberately before using another sender.');
  if (requirePostalAddress && (!sender.postalAddress?.trim() || /[<>\u0000-\u001f]/.test(sender.postalAddress) || /^(?:your|enter|placeholder|test|example|todo)\b/i.test(sender.postalAddress))) throw new Error('Add your valid physical postal address to the local config before preparing or sending emails.');
  if (sender.instagram !== 'https://www.instagram.com/whitewo_lf404/') throw new Error('Use the Instagram URL supplied for this pilot.');
}

export function draftEmail(lead, sender) {
  validateSender(sender);
  if (!validEmail(lead.email)) throw new Error('Recipient email is invalid.');
  const { service, benefit } = serviceDetails(lead.category);
  const variant = createHash('sha256').update(lead.id).digest()[0] % 3;
  const messages = [
    `I came across ${lead.businessName}'s ${service} listing on Google Maps and wanted to reach out briefly.\n\nWould a professional website that lets you ${benefit} be useful for your business? I build straightforward, custom websites with services, project photos, testimonials, and clear ways to get in touch.\n\nIf that sounds interesting, reply and we can discuss what would work for you. I'd be happy to share a free demo first.`,
    `A quick introduction: I'm Afif, and I build websites for local businesses. I found ${lead.businessName} listed for ${service} on Google Maps.\n\nA website could give you a place to ${benefit}. I'd put together a clear, professional design around your work, your services, and your contact details.\n\nWould you be interested in discussing it? I can also share a free demo if you'd like.`,
    `I found ${lead.businessName}'s ${service} listing on Google Maps and had a website idea to share.\n\nA simple, professional site could help you ${benefit}. It would give potential customers a clear introduction to your business, with project photos, services, testimonials, and contact details.\n\nIf you're interested, let me know and we can discuss it further. I can share a free demo to help you decide.`
  ];
  const subject = [`A website idea for ${lead.businessName}`, `${lead.businessName} — a quick website introduction`, `Website design for ${lead.businessName}`][variant];
  return { to: lead.email.toLowerCase(), subject,
    body: `Hi ${lead.businessName} team,\n\n${messages[variant]}\n\nBest,\n${sender.name}\nInstagram: ${sender.instagram}\n\nWebsite design offer from ${sender.name}\n${sender.postalAddress.trim()}\nTo stop marketing emails from me, reply \"no\".` };
}

export function rawMessage(draft, sender, messageId) {
  validateSender(sender);
  if (!validEmail(draft.to) || /[\r\n\u0000-\u001f]/.test(draft.subject)) throw new Error('Unsafe recipient or subject.');
  if (!/^[a-z0-9-]+@gmail\.com$/i.test(messageId)) throw new Error('Invalid message ID.');
  const encode = value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
  const header = [
    `From: ${encode(sender.name)} <${sender.email}>`, `To: <${draft.to}>`, `Reply-To: <${sender.email}>`,
    `Subject: ${encode(draft.subject)}`, `Message-ID: <${messageId}>`, `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'
  ];
  const body = Buffer.from(draft.body.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g).join('\r\n');
  return Buffer.from(`${header.join('\r\n')}\r\n\r\n${body}\r\n`).toString('base64url');
}
