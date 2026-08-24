'use client';

// The Researcher conversation — greeting, message trail, and the live
// streaming run. Shared verbatim by the drawer, the full-screen
// workspace, and the read-only share page; surfaces wrap it in their
// own scroll container (attach chat.scrollRef) and CSS scope.
import { useState } from 'react';
import type { AssistantPayload, Footprint } from '@/lib/researcher/types';
import { BlockView, CitationChips } from './blocks';
import { useSurface } from './surface';
import { greetingWord, type ResearcherChat } from './use-researcher-chat';
import styles from './researcher.module.css';

export function Conversation({ chat, projectId, name, readOnly = false }: {
  chat: ResearcherChat;
  projectId: string;
  name: string;
  readOnly?: boolean;
}) {
  const { messages, live, observations } = chat;
  const showGreeting = !readOnly && messages.length === 0 && live === null;

  return (
    <>
      {showGreeting && (
        <div className={styles.hello}>
          <h2>{greetingWord()}, {name}.</h2>
          {observations && observations.length > 0 && (
            <>
              <div className={styles.noticed}>While you were away I noticed</div>
              <div className={styles.obs}>
                {observations.map((o, i) => (
                  <button key={i} type="button" className={styles.obsBtn} onClick={() => chat.ask(o.question)}>
                    {o.text.includes('{strong}')
                      ? <>{o.text.split('{strong}')[0]}<b>{o.strong}</b>{o.text.split('{strong}')[1]}</>
                      : <><b>{o.strong}</b>{o.text}</>}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className={styles.wayfind}>Ask anything you’d like to learn about your data.</div>
        </div>
      )}

      {messages.map((msg) => msg.role === 'user'
        ? <div key={msg.id} className={styles.msgUser}>{msg.content}</div>
        : (
          <AssistantMessage
            key={msg.id}
            content={msg.content}
            payload={msg.payload}
            projectId={projectId}
            threadId={chat.threadId}
            readOnly={readOnly}
            onAsk={chat.ask}
            onRetry={chat.retryLast}
          />
        ))}

      {live && (
        <div className={styles.msgAi}>
          <span className={styles.threadLine}>
            <i className={styles.threadLineFill} style={{ height: live.composing || live.error ? '100%' : `${Math.min(90, (live.footprints.length + 1) * 28)}%` }} />
          </span>
          <div>
            {live.statusLabel && (
              <div className={styles.status}><i className={styles.statusDot} /><span>{live.statusLabel}</span></div>
            )}
            {live.composing && live.footprints.length > 0 && <FootprintsView footprints={live.footprints} />}
            {live.text && <div className={`${styles.prose} ${styles.caret}`}>{live.text}</div>}
            {live.blocks.map((b, i) => <BlockView key={i} block={b} projectId={projectId} threadId={chat.threadId} />)}
            {live.error && (
              <div className={styles.busyNote}>
                {live.error}
                <div className={styles.stopped}>
                  <button type="button" onClick={chat.retryLive}>Try again</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function FootprintsView({ footprints }: { footprints: Footprint[] }) {
  const [openF, setOpenF] = useState(false);
  const total = (footprints.reduce((s, f) => s + f.ms, 0) / 1000).toFixed(1);
  return (
    <div>
      <button type="button" className={styles.footprints} onClick={() => setOpenF(!openF)}>
        Researched · {footprints.length} step{footprints.length === 1 ? '' : 's'} · {total}s
        <span className={`${styles.chev} ${openF ? styles.chevOpen : ''}`}>▼</span>
      </button>
      {openF && (
        <div className={styles.fpList}>
          {footprints.map((f, i) => (
            <div key={i} className={styles.fpStep}>
              {f.label}
              <span className={styles.fpDur}>{(f.ms / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ content, payload, projectId, threadId, readOnly, onAsk, onRetry }: {
  content: string;
  payload: AssistantPayload | null;
  projectId: string;
  threadId: string | null;
  readOnly: boolean;
  onAsk: (q: string) => void;
  onRetry: () => void;
}) {
  const surface = useSurface();
  const p = payload;
  return (
    <div className={styles.msgAi}>
      <span className={styles.threadLine}><i className={styles.threadLineFill} style={{ height: '100%' }} /></span>
      <div>
        {p && p.footprints.length > 0 && <FootprintsView footprints={p.footprints.filter((f) => f.name !== 'compose')} />}
        {content && <div className={styles.prose}>{content}</div>}
        {p?.blocks.map((b, i) => <BlockView key={i} block={b} projectId={projectId} threadId={threadId} />)}
        {p?.caveat && <div className={styles.caveat}>{p.caveat}</div>}
        {p?.link && surface !== 'share' && (
          <a className={styles.go} href={p.link.href} target="_blank" rel="noreferrer">{p.link.label}</a>
        )}
        {/* Citation chips only for sources the view-nav link doesn't
            already open — a lone "Clusters" chip under "Open the cluster
            map →" says nothing new. */}
        {p && <CitationChips citations={p.citations.filter((c) => c.href !== p.link?.href)} />}
        {p?.interrupted && !readOnly && (
          <div className={styles.stopped}>
            Response interrupted
            <button type="button" onClick={onRetry}>Ask again</button>
          </div>
        )}
        {!readOnly && p && p.followups.length > 0 && (
          <div className={styles.followups}>
            {p.followups.map((f) => (
              <button key={f} type="button" className={styles.fuBtn} onClick={() => onAsk(f)}>
                <span className={styles.qdot} />{f}
              </button>
            ))}
          </div>
        )}
        {!readOnly && p && !p.interrupted && (
          <div className={styles.actions}>
            <button type="button" onClick={onRetry}>Retry</button>
            <button type="button" onClick={() => { navigator.clipboard?.writeText(content).catch(() => {}); }}>Copy</button>
          </div>
        )}
      </div>
    </div>
  );
}
