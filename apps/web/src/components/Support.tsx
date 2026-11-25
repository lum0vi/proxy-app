import { ArrowUpRight, MessageCircle } from 'lucide-react';
import { usePreferences } from '../lib/preferences';

export const supportTelegram = { href: 'https://t.me/zybato', handle: '@zybato' } as const;

export function SupportSection() {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  return <section className="store-section" id="support" aria-labelledby="support-title">
    <div className="store-support">
      <div className="support-copy"><span className="comparison-eyebrow"><MessageCircle size={16} aria-hidden="true"/> {ru ? 'ДАВАЙТЕ ОБСУДИМ' : 'LET’S TALK'}</span>
        <h2 id="support-title">{ru ? 'Остались вопросы?' : 'Have a question?'}</h2>
        <p>{ru ? 'Нужна помощь с ключом, оплатой или подключением? Есть идея, как улучшить сервис? Напишите нам в Telegram.' : 'Need help with a key, payment or setup? Have an idea to improve the service? Message us on Telegram.'}</p>
        <small>{ru ? 'Для вопроса по оплате укажите номер заказа. Пароли, полный API-ключ и seed-фразы присылать не нужно.' : 'For payment questions, include your order number. Do not send passwords, full API keys or seed phrases.'}</small>
      </div>
      <a className="support-contact" href={supportTelegram.href} target="_blank" rel="noopener noreferrer">
        <MessageCircle size={28} aria-hidden="true"/><span><small>Telegram</small><strong>{supportTelegram.handle}</strong><span>{ru ? 'Помощь и предложения' : 'Help and feedback'}</span></span><ArrowUpRight size={22} aria-hidden="true"/>
      </a>
    </div>
  </section>;
}
