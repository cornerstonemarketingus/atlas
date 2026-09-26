import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingNav } from "../MarketingNav.js";

export const metadata: Metadata = {
  title: "About — Atlas",
  description: "Who builds Atlas, why it exists, and how it is built.",
};

export default function AboutPage() {
  return <main>
    <MarketingNav />
    <section className="marketing-hero compact">
      <p className="eyebrow"><span>ABOUT</span> Who builds Atlas</p>
      <h1>A small, independent<br /><em>product.</em></h1>
      <p>Atlas is built by Anthony Hahn, an independent founder based in Minnesota. It started as a tool for his own work: one assistant that could answer questions, change code, and handle the repetitive browser work that eats up a day.</p>
    </section>
    <section className="about-body">
      <div>
        <h2>Why Atlas exists</h2>
        <p>Most AI tools stop at an answer. You still copy the code into your project, run the tests, open the pull request, and click through the website yourself.</p>
        <p>Atlas is meant to do those steps for you, in your own GitHub repositories and on your own computer, and to show you exactly what it did.</p>
        <h2>How we build it</h2>
        <ul>
          <li>Atlas asks before anything important: sending, submitting, buying, or changing an account.</li>
          <li>Every code change is a pull request you can read, with the tests that ran.</li>
          <li>Your code and credentials stay in your accounts. Atlas works with the model of your choice, including one running on your own machine.</li>
          <li>We say plainly what works today and what is still being built.</li>
        </ul>
      </div>
      <div>
        <h2>Where it is today</h2>
        <p>Chat, code changes through GitHub, and browser tasks on a paired Windows PC work now. A hosted browser, a mobile app, and more hands-off automation are in progress.</p>
        <p>Atlas can also work on itself: the owner asks it in chat to improve Atlas, and the change arrives as a tested pull request.</p>
        <h2>Get in touch</h2>
        <p>Questions, bugs, and ideas go to the <a href="https://github.com/cornerstonemarketingus/atlas/issues">Atlas issue tracker</a> on GitHub.</p>
        <p><Link href="/">Try Atlas free →</Link></p>
      </div>
    </section>
    <MarketingFooter />
  </main>;
}
