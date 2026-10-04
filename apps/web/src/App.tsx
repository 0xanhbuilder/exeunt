import { AlertBanner } from "./components/AlertBanner";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { NetworkProvider, useNetwork } from "./lib/network-context";
import { useRoute } from "./lib/router";
import { WalletProvider } from "./lib/wallet-context";
import { BuyPage } from "./pages/buy/BuyPage";
import { DevelopersPage } from "./pages/developers/DevelopersPage";
import { EarnPage } from "./pages/earn/EarnPage";
import { FrozenPage } from "./pages/frozen/FrozenPage";
import { OverviewPage } from "./pages/overview/OverviewPage";
import { SellPage } from "./pages/sell/SellPage";

export function App() {
  return (
    <NetworkProvider>
      <WalletProvider>
        <Shell />
      </WalletProvider>
    </NetworkProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { key } = useNetwork();
  return (
    <div className="app">
      <Header route={route} />
      <AlertBanner />
      {/* Keyed by network so every form and cache starts fresh after a switch. */}
      <main className="container page" key={`${route}:${key}`} data-testid={`page-${route}`}>
        {route === "overview" && <OverviewPage />}
        {route === "sell" && <SellPage />}
        {route === "buy" && <BuyPage />}
        {route === "earn" && <EarnPage />}
        {route === "frozen" && <FrozenPage />}
        {route === "developers" && <DevelopersPage />}
      </main>
      <Footer />
    </div>
  );
}
