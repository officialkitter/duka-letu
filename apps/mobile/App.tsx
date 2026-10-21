import NetInfo from '@react-native-community/netinfo';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import {
  ArrowDownUp,
  ArrowRight,
  Check,
  ChevronRight,
  CloudUpload,
  CreditCard,
  Grid2X2,
  Leaf,
  LockKeyhole,
  LogOut,
  Mail,
  Minus,
  Plus,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react-native';
import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from 'react-native';
import type { ReactElement, ReactNode } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  clearLocalData,
  getDashboardData,
  getIdentity,
  initializeDatabase,
  MOCK_MODE,
  saveCashSale,
  setIdentity,
  syncWithServer,
} from './src/data';
import type { DashboardData, Identity, Product, Sale } from './src/types';
import { colors, shadow } from './src/theme';
import { MOCK_PASSWORD } from './src/mock';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type Tab = 'register' | 'activity' | 'settings';

const emptyData: DashboardData = {
  products: [],
  sales: [],
  tenant: null,
  pending: 0,
  rejected: 0,
  todaySalesTotal: 0,
  todaySalesCount: 0,
};

function money(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: code,
  }).format(cents / 10 ** digits);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function RiseIn({ children, delay = 0, style }: { children: ReactNode; delay?: number; style?: object }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(progress, {
      toValue: 1,
      delay,
      useNativeDriver: true,
      damping: 18,
      stiffness: 115,
      mass: 0.8,
    }).start();
  }, [delay, progress]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

function BrandMark({ size = 42 }: { size?: number }) {
  return (
    <LinearGradient
      colors={[colors.green, colors.greenDeep]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.brandMark, { width: size, height: size, borderRadius: size * 0.33 }]}
    >
      <Leaf size={size * 0.48} color={colors.lime} strokeWidth={2.2} />
    </LinearGradient>
  );
}

export default function App() {
  const [identity, setCurrentIdentity] = useState<Identity | null>(null);
  const [data, setData] = useState<DashboardData>(emptyData);
  const [booting, setBooting] = useState(true);
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<Tab>('register');
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const syncLock = useRef(false);

  const currency = data.tenant?.currency ?? 'usd';
  const items = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, quantity]) => ({ product: data.products.find((product) => product.id === id), quantity }))
        .filter((item): item is { product: Product; quantity: number } => Boolean(item.product && item.quantity > 0)),
    [cart, data.products],
  );
  const totals = useMemo(
    () =>
      items.reduce(
        (sum, { product, quantity }) => {
          const line = product.price_cents * quantity;
          sum.subtotal += line;
          sum.tax += Math.round((line * product.tax_rate_bps) / 10_000);
          return sum;
        },
        { subtotal: 0, tax: 0 },
      ),
    [items],
  );
  const total = totals.subtotal + totals.tax;
  const filteredProducts = data.products.filter((product) =>
    product.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const refreshData = useCallback(async () => {
    setData(await getDashboardData());
  }, []);

  const runSync = useCallback(
    async (showSuccess = false) => {
      if (syncLock.current || !identity || !online) return;
      syncLock.current = true;
      setSyncing(true);
      try {
        await syncWithServer();
        const latestData = await getDashboardData();
        setData(latestData);
        if (showSuccess) {
          if (latestData.rejected > 0) {
            setMessage({ kind: 'error', text: `${latestData.rejected} sale${latestData.rejected === 1 ? '' : 's'} need review in Activity.` });
          } else if (latestData.pending > 0) {
            setMessage({ kind: 'error', text: `${latestData.pending} sale${latestData.pending === 1 ? '' : 's'} will retry on your next sync.` });
          } else {
            setMessage({ kind: 'success', text: 'Your register is all caught up.' });
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        }
      } catch (error) {
        setMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Sync failed. Your sales are safe on this device.',
        });
      } finally {
        syncLock.current = false;
        setSyncing(false);
      }
    },
    [identity, online, refreshData],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await initializeDatabase();
        const [savedIdentity, initialData] = await Promise.all([getIdentity(), getDashboardData()]);
        if (!active) return;
        setCurrentIdentity(savedIdentity);
        setData(initialData);
      } catch (error) {
        Alert.alert('Could not start the register', error instanceof Error ? error.message : 'Please restart the app.');
      } finally {
        if (active) setBooting(false);
      }
    })();
    const unsubscribe = NetInfo.addEventListener((state) => setOnline(state.isConnected === true));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (identity && online) void runSync();
  }, [identity, online, runSync]);

  async function handleLogin() {
    setLoginBusy(true);
    setLoginError('');
    try {
      const nextIdentity = await setIdentity(email.trim(), password);
      setCurrentIdentity(nextIdentity);
      setPassword('');
      setData(await getDashboardData());
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Sign-in failed. Please try again.');
    } finally {
      setLoginBusy(false);
    }
  }

  function changeQuantity(product: Product, delta: number) {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCart((current) => {
      const quantity = Math.max(0, (current[product.id] ?? 0) + delta);
      const next = { ...current };
      if (quantity === 0) delete next[product.id];
      else next[product.id] = quantity;
      return next;
    });
    if (delta > 0) void Haptics.selectionAsync();
  }

  async function handleCheckout() {
    if (!identity || !items.length || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await saveCashSale(items, identity, currency);
      await refreshData();
      setCart({});
      setCheckoutOpen(false);
      setMessage({
        kind: 'success',
        text: online ? 'Sale complete. Your register is up to date.' : 'Sale saved securely on this device. It will sync when you reconnect.',
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'The sale could not be saved.' });
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    if (data.pending > 0) {
      Alert.alert(
        'Sales still need to sync',
        `${data.pending} sale${data.pending === 1 ? '' : 's'} are stored on this device. Sync them before signing out.`,
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Sync now', onPress: () => void runSync(true) },
        ],
      );
      return;
    }
    try {
      await clearLocalData();
      setCurrentIdentity(null);
      setData(emptyData);
      setCart({});
    } catch (error) {
      Alert.alert('Could not sign out', error instanceof Error ? error.message : 'Please try again.');
    }
  }

  if (booting) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <StatusBar style="dark" />
        <BrandMark size={58} />
        <ActivityIndicator color={colors.green} style={styles.loadingSpinner} />
        <Text style={styles.loadingText}>Getting your store ready</Text>
      </SafeAreaView>
    );
  }

  if (!identity) {
    return (
      <SafeAreaView style={styles.loginScreen}>
        <StatusBar style="light" />
        <LinearGradient
          colors={[colors.greenDeep, colors.green]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.loginHero}
        >
          <View style={styles.loginGlow} />
          <BrandMark size={58} />
          <Text style={styles.loginEyebrow}>MADE FOR YOUR EVERYDAY</Text>
          <Text style={styles.loginTitle}>Your business,{"\n"}in good hands.</Text>
          <Text style={styles.loginSubtitle}>A calmer, smarter way to run your shop.</Text>
          <Sparkles size={18} color={colors.lime} style={styles.loginSparkle} />
        </LinearGradient>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.loginFormWrap}>
          <Text style={styles.loginFormTitle}>Welcome back</Text>
          <Text style={styles.loginFormHint}>Sign in to open your register.</Text>
          {MOCK_MODE && (
            <View style={styles.demoRow}>
              <Text style={styles.demoLabel}>Demo mode · tap to fill</Text>
              {(['cashier', 'manager', 'owner'] as const).map((role) => (
                <Pressable
                  key={role}
                  accessibilityRole="button"
                  onPress={() => {
                    setEmail(`${role}@dukaletu.test`);
                    setPassword(MOCK_PASSWORD);
                  }}
                  style={styles.demoChip}
                >
                  <Text style={styles.demoChipText}>{role}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={styles.loginInput}>
            <Mail size={18} color={colors.muted} />
            <TextInput
              accessibilityLabel="Email"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder="Email address"
              placeholderTextColor={colors.muted}
              returnKeyType="next"
              value={email}
              onChangeText={setEmail}
              style={styles.loginTextInput}
            />
          </View>
          <View style={styles.loginInput}>
            <LockKeyhole size={18} color={colors.muted} />
            <TextInput
              accessibilityLabel="Password"
              autoCapitalize="none"
              autoComplete="current-password"
              placeholder="Password"
              placeholderTextColor={colors.muted}
              secureTextEntry
              returnKeyType="go"
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => void handleLogin()}
              style={styles.loginTextInput}
            />
          </View>
          {loginError ? <Text style={styles.loginError}>{loginError}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={loginBusy || !email.trim() || !password}
            onPress={() => void handleLogin()}
            style={({ pressed }) => [
              styles.loginButton,
              pressed && styles.pressed,
              (loginBusy || !email.trim() || !password) && styles.disabled,
            ]}
          >
            {loginBusy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.loginButtonText}>Sign in</Text>}
            {!loginBusy && <ArrowRight size={18} color={colors.white} />}
          </Pressable>
          <Text style={styles.offlineFirst}>Your first sign-in needs an internet connection.</Text>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  const addToCart = (product: Product) => changeQuantity(product, 1);

  return (
    <SafeAreaView style={styles.app} edges={['top', 'bottom', 'left', 'right']}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={styles.brand}>
          <BrandMark size={40} />
          <View>
            <Text style={styles.brandName}>duka<Text style={styles.brandNameAccent}>letu</Text></Text>
            <Text style={styles.storeName}>{data.tenant?.name ?? 'YOUR STORE'}</Text>
          </View>
        </View>
        <View style={[styles.networkPill, online ? styles.networkOnline : styles.networkOffline]}>
          {online ? <Wifi size={13} color={colors.green} /> : <WifiOff size={13} color={colors.orange} />}
          <Text style={[styles.networkText, !online && styles.networkTextOffline]}>{online ? 'ONLINE' : 'OFFLINE'}</Text>
        </View>
      </View>

      {tab === 'register' ? (
        <ScrollView
          contentContainerStyle={[styles.scrollContent, items.length > 0 && styles.scrollWithCart]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <RiseIn>
            <View style={styles.greetingRow}>
              <View>
                <Text style={styles.eyebrow}>YOUR STORE TODAY</Text>
                <Text style={styles.greeting}>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'} 👋</Text>
              </View>
              <View style={styles.avatar}><Text style={styles.avatarText}>{identity.email.slice(0, 1).toUpperCase()}</Text></View>
            </View>
          </RiseIn>

          <RiseIn delay={70}>
            <LinearGradient
              colors={[colors.greenDeep, colors.green]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.salesHero}
            >
              <View style={styles.heroOrb} />
              <View style={styles.heroTop}>
                <View style={styles.heroLabelRow}>
                  <Sparkles size={14} color={colors.lime} />
                  <Text style={styles.heroLabel}>TODAY'S SALES</Text>
                </View>
                <View style={styles.liveTag}><View style={styles.liveDot} /><Text style={styles.liveText}>LIVE</Text></View>
              </View>
              <Text style={styles.heroAmount}>{money(data.todaySalesTotal, currency)}</Text>
              <View style={styles.heroFoot}>
                <Text style={styles.heroFootText}>{data.todaySalesCount} {data.todaySalesCount === 1 ? 'sale' : 'sales'} today</Text>
                <View style={styles.heroFootBadge}><ArrowDownUp size={12} color={colors.lime} /><Text style={styles.heroFootBadgeText}>LOCAL</Text></View>
              </View>
            </LinearGradient>
          </RiseIn>

          {message && <FeedbackBanner message={message} onDismiss={() => setMessage(null)} />}

          <RiseIn delay={130}>
            <View style={styles.sectionHeading}>
              <View>
                <Text style={styles.sectionTitle}>Your products</Text>
                <Text style={styles.sectionHint}>{filteredProducts.length} items ready to sell</Text>
              </View>
              <View style={styles.catalogBadge}><Grid2X2 size={14} color={colors.green} /><Text style={styles.catalogBadgeText}>CATALOG</Text></View>
            </View>
            <View style={styles.searchBar}>
              <Search size={18} color={colors.muted} />
              <TextInput
                accessibilityLabel="Search products"
                placeholder="Find a product..."
                placeholderTextColor={colors.muted}
                value={query}
                onChangeText={setQuery}
                style={styles.searchInput}
              />
              {query.length > 0 && (
                <Pressable accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={10}>
                  <X size={17} color={colors.muted} />
                </Pressable>
              )}
            </View>
          </RiseIn>

          {filteredProducts.length > 0 ? (
            <View style={styles.productGrid}>
              {filteredProducts.map((product, index) => {
                const quantity = cart[product.id] ?? 0;
                return (
                  <RiseIn key={product.id} delay={Math.min(170 + index * 28, 360)} style={styles.productCell}>
                    <ProductCard product={product} currency={currency} quantity={quantity} onAdd={() => addToCart(product)} />
                  </RiseIn>
                );
              })}
            </View>
          ) : (
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}><ShoppingBag size={22} color={colors.green} /></View>
              <Text style={styles.emptyTitle}>{query ? 'Nothing matched that search' : 'Your catalog is on its way'}</Text>
              <Text style={styles.emptyHint}>
                {query ? 'Try a different product name.' : online ? 'Your products will appear here after the first sync.' : 'Connect once to download your store catalog.'}
              </Text>
              {online && <Pressable onPress={() => void runSync(true)} style={styles.outlineButton}><Text style={styles.outlineButtonText}>Sync catalog</Text></Pressable>}
            </View>
          )}
          <Text style={styles.catalogFootnote}><CloudUpload size={13} color={colors.muted} /> Works offline. Sales sync when you reconnect.</Text>
        </ScrollView>
      ) : tab === 'activity' ? (
        <ActivityScreen sales={data.sales} currency={currency} />
      ) : (
        <SettingsScreen
          identity={identity}
          online={online}
          syncing={syncing}
          pending={data.pending}
          rejected={data.rejected}
          message={message}
          onDismissMessage={() => setMessage(null)}
          onSync={() => void runSync(true)}
          onSignOut={() => void handleSignOut()}
        />
      )}

      {tab === 'register' && items.length > 0 && (
        <RiseIn style={styles.cartDock}>
          <Pressable accessibilityRole="button" onPress={() => setCheckoutOpen(true)} style={({ pressed }) => [styles.cartDockButton, pressed && styles.pressed]}>
            <View style={styles.cartCount}><Text style={styles.cartCountText}>{items.reduce((sum, item) => sum + item.quantity, 0)}</Text></View>
            <Text style={styles.cartDockTitle}>Review sale</Text>
            <Text style={styles.cartDockAmount}>{money(total, currency)}</Text>
            <View style={styles.cartDockArrow}><ArrowRight size={16} color={colors.greenDeep} /></View>
          </Pressable>
        </RiseIn>
      )}

      <View style={styles.tabBar}>
        <TabButton active={tab === 'register'} icon={<ShoppingBag size={19} />} label="Register" onPress={() => setTab('register')} />
        <TabButton active={tab === 'activity'} icon={<ArrowDownUp size={19} />} label="Activity" onPress={() => setTab('activity')} />
        <TabButton active={tab === 'settings'} icon={<SlidersHorizontal size={19} />} label="Settings" onPress={() => setTab('settings')} />
      </View>

      <CheckoutModal
        visible={checkoutOpen}
        items={items}
        currency={currency}
        subtotal={totals.subtotal}
        tax={totals.tax}
        total={total}
        online={online}
        busy={busy}
        onClose={() => setCheckoutOpen(false)}
        onQuantityChange={changeQuantity}
        onPay={handleCheckout}
      />
    </SafeAreaView>
  );
}

function ProductCard({
  product,
  currency,
  quantity,
  onAdd,
}: {
  product: Product;
  currency: string;
  quantity: number;
  onAdd: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  function pressIn() {
    Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 28, bounciness: 4 }).start();
  }
  function pressOut() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 28, bounciness: 4 }).start();
  }

  return (
    <Animated.View style={[styles.productCard, quantity > 0 && styles.productCardSelected, { transform: [{ scale }] }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add ${product.name}, ${money(product.price_cents, currency)}`}
        onPressIn={pressIn}
        onPressOut={pressOut}
        onPress={onAdd}
        style={styles.productCardPress}
      >
        <View style={styles.productCardTop}>
          <LinearGradient colors={[colors.mint, colors.limePale]} style={styles.productGlyph}>
            <Text style={styles.productGlyphText}>{product.name.trim().slice(0, 1).toUpperCase()}</Text>
          </LinearGradient>
          {quantity > 0 ? (
            <View style={styles.quantityBadge}><Text style={styles.quantityBadgeText}>{quantity}</Text></View>
          ) : (
            <View style={styles.addProduct}><Plus size={16} color={colors.green} strokeWidth={2.4} /></View>
          )}
        </View>
        <View>
          <Text numberOfLines={2} style={styles.productName}>{product.name}</Text>
          <Text style={styles.productSku}>{product.sku?.trim() || 'IN YOUR SHOP'}</Text>
        </View>
        <Text style={styles.productPrice}>{money(product.price_cents, currency)}</Text>
      </Pressable>
    </Animated.View>
  );
}

function FeedbackBanner({
  message,
  onDismiss,
}: {
  message: { kind: 'success' | 'error'; text: string };
  onDismiss: () => void;
}) {
  const success = message.kind === 'success';
  return (
    <View style={[styles.feedbackBanner, success ? styles.feedbackSuccess : styles.feedbackError]}>
      {success ? <Check size={17} color={colors.green} /> : <WifiOff size={17} color={colors.orange} />}
      <Text style={[styles.feedbackText, !success && styles.feedbackErrorText]}>{message.text}</Text>
      <Pressable accessibilityLabel="Dismiss message" onPress={onDismiss} hitSlop={10}><X size={16} color={success ? colors.green : colors.orange} /></Pressable>
    </View>
  );
}

function ActivityScreen({ sales, currency }: { sales: Sale[]; currency: string }) {
  return (
    <ScrollView contentContainerStyle={styles.secondaryScroll} showsVerticalScrollIndicator={false}>
      <RiseIn>
        <Text style={styles.eyebrow}>THE DAY, AT A GLANCE</Text>
        <Text style={styles.screenTitle}>Sales activity</Text>
        <Text style={styles.screenSubtitle}>Your recent transactions, synced or safely on this device.</Text>
      </RiseIn>
      <RiseIn delay={70}>
        <View style={styles.activitySummary}>
          <View style={styles.activitySummaryIcon}><ArrowDownUp size={18} color={colors.green} /></View>
          <View style={styles.grow}><Text style={styles.activitySummaryLabel}>TRANSACTIONS</Text><Text style={styles.activitySummaryValue}>{sales.length} recent sales</Text></View>
          <ChevronRight size={18} color={colors.muted} />
        </View>
      </RiseIn>
      <Text style={styles.listHeading}>RECENT SALES</Text>
      {sales.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}><ArrowDownUp size={22} color={colors.green} /></View>
          <Text style={styles.emptyTitle}>A fresh start</Text>
          <Text style={styles.emptyHint}>Completed sales will show up here.</Text>
        </View>
      ) : (
        <View style={styles.saleList}>
          {sales.map((sale, index) => (
            <RiseIn key={sale.id} delay={Math.min(index * 35, 280)}>
              <View style={styles.saleRow}>
                <View style={[styles.saleIcon, sale.sync_status === 'rejected' && styles.saleIconRejected]}>
                  {sale.sync_status === 'synced' ? <Check size={17} color={colors.green} /> : sale.sync_status === 'rejected' ? <X size={17} color={colors.orange} /> : <CloudUpload size={17} color={colors.gold} />}
                </View>
                <View style={styles.grow}>
                  <Text style={styles.saleTitle}>{shortDate(sale.occurred_at)} · {sale.status === 'completed' ? 'Sale' : 'Voided'}</Text>
                  <Text style={styles.saleMeta}>{sale.sync_reason || syncLabel(sale.sync_status)}</Text>
                </View>
                <Text style={styles.saleAmount}>{money(sale.total_cents, sale.currency || currency)}</Text>
              </View>
            </RiseIn>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function syncLabel(status: Sale['sync_status']): string {
  if (status === 'synced') return 'Synced';
  if (status === 'rejected') return 'Needs review';
  return 'Waiting to sync';
}

function SettingsScreen({
  identity,
  online,
  syncing,
  pending,
  rejected,
  message,
  onDismissMessage,
  onSync,
  onSignOut,
}: {
  identity: Identity;
  online: boolean;
  syncing: boolean;
  pending: number;
  rejected: number;
  message: { kind: 'success' | 'error'; text: string } | null;
  onDismissMessage: () => void;
  onSync: () => void;
  onSignOut: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.secondaryScroll} showsVerticalScrollIndicator={false}>
      <RiseIn>
        <Text style={styles.eyebrow}>YOUR SPACE</Text>
        <Text style={styles.screenTitle}>Settings</Text>
        <Text style={styles.screenSubtitle}>The little details that keep your shop running.</Text>
      </RiseIn>
      {message && <FeedbackBanner message={message} onDismiss={onDismissMessage} />}
      <RiseIn delay={60}>
        <View style={styles.accountCard}>
          <View style={styles.accountAvatar}><Text style={styles.accountAvatarText}>{identity.email.slice(0, 1).toUpperCase()}</Text></View>
          <View style={styles.grow}><Text style={styles.accountLabel}>SIGNED IN AS</Text><Text numberOfLines={1} style={styles.accountEmail}>{identity.email}</Text><Text style={styles.accountRole}>{identity.role.toUpperCase()} · STAFF ACCOUNT</Text></View>
        </View>
      </RiseIn>
      <Text style={styles.listHeading}>DEVICE & SYNC</Text>
      <View style={styles.settingsCard}>
        <View style={styles.settingRow}>
          <View style={[styles.settingIcon, online ? styles.settingIconOnline : styles.settingIconOffline]}>{online ? <Wifi size={17} color={colors.green} /> : <WifiOff size={17} color={colors.orange} />}</View>
          <View style={styles.grow}><Text style={styles.settingTitle}>{online ? 'You’re connected' : 'Working offline'}</Text><Text style={styles.settingHint}>{online ? 'Your register can reach the server.' : 'Cash sales stay safe on this device.'}</Text></View>
          <View style={[styles.stateDot, online ? styles.stateDotOnline : styles.stateDotOffline]} />
        </View>
        <View style={styles.settingDivider} />
        <View style={styles.settingRow}>
          <View style={styles.settingIcon}><CloudUpload size={17} color={colors.green} /></View>
          <View style={styles.grow}><Text style={styles.settingTitle}>{pending === 0 ? 'All caught up' : `${pending} sale${pending === 1 ? '' : 's'} to sync`}</Text><Text style={styles.settingHint}>{rejected > 0 ? `${rejected} sale${rejected === 1 ? '' : 's'} need a manager’s attention.` : 'Your outbox is stored securely on device.'}</Text></View>
        </View>
        <Pressable accessibilityRole="button" disabled={!online || syncing} onPress={onSync} style={({ pressed }) => [styles.syncButton, pressed && styles.pressed, (!online || syncing) && styles.disabled]}>
          {syncing ? <ActivityIndicator size="small" color={colors.white} /> : <ArrowDownUp size={16} color={colors.white} />}
          <Text style={styles.syncButtonText}>{syncing ? 'Syncing your store…' : 'Sync now'}</Text>
        </Pressable>
      </View>
      <View style={styles.infoCard}>
        <View style={styles.infoIcon}><CreditCard size={18} color={colors.green} /></View>
        <Text style={styles.infoTitle}>Payment options</Text>
        <Text style={styles.infoBody}>Cash is available in this mobile register, online or offline. Card readers are supported in the web register, but aren’t configured for this native app yet.</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onSignOut} style={({ pressed }) => [styles.signOutButton, pressed && styles.pressed]}>
        <LogOut size={17} color={colors.orange} />
        <Text style={styles.signOutText}>Sign out</Text>
        <ChevronRight size={17} color={colors.muted} />
      </Pressable>
      <Text style={styles.versionText}>DUKALETU · MADE FOR EVERYDAY</Text>
    </ScrollView>
  );
}

function TabButton({ active, icon, label, onPress }: { active: boolean; icon: ReactElement<{ color?: string; size?: number }>; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={onPress} style={styles.tabButton}>
      <View style={[styles.tabIcon, active && styles.tabIconActive]}>{cloneElement(icon, { color: active ? colors.green : colors.muted, size: 19 })}</View>
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function CheckoutModal({
  visible,
  items,
  currency,
  subtotal,
  tax,
  total,
  online,
  busy,
  onClose,
  onQuantityChange,
  onPay,
}: {
  visible: boolean;
  items: { product: Product; quantity: number }[];
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  online: boolean;
  busy: boolean;
  onClose: () => void;
  onQuantityChange: (product: Product, delta: number) => void;
  onPay: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.modalRoot}>
        <Pressable accessibilityLabel="Close checkout" onPress={onClose} style={styles.modalScrim} />
        <SafeAreaView edges={['bottom']} style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <View><Text style={styles.modalEyebrow}>ONE LAST LOOK</Text><Text style={styles.modalTitle}>Your sale</Text></View>
            <Pressable accessibilityLabel="Close checkout" onPress={onClose} style={styles.closeButton}><X size={19} color={colors.ink} /></Pressable>
          </View>
          <ScrollView style={styles.checkoutList} showsVerticalScrollIndicator={false}>
            {items.map(({ product, quantity }) => (
              <View key={product.id} style={styles.checkoutRow}>
                <View style={styles.checkoutGlyph}><Text style={styles.checkoutGlyphText}>{product.name.slice(0, 1).toUpperCase()}</Text></View>
                <View style={styles.grow}><Text numberOfLines={1} style={styles.checkoutName}>{product.name}</Text><Text style={styles.checkoutUnit}>{money(product.price_cents, currency)} each</Text></View>
                <View style={styles.quantityControls}>
                  <Pressable accessibilityLabel={`Remove one ${product.name}`} onPress={() => onQuantityChange(product, -1)} style={styles.quantityControl}><Minus size={14} color={colors.green} /></Pressable>
                  <Text style={styles.checkoutQuantity}>{quantity}</Text>
                  <Pressable accessibilityLabel={`Add one ${product.name}`} onPress={() => onQuantityChange(product, 1)} style={styles.quantityControl}><Plus size={14} color={colors.green} /></Pressable>
                </View>
                <Text style={styles.checkoutLineTotal}>{money(product.price_cents * quantity, currency)}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.checkoutTotals}>
            <View style={styles.totalRow}><Text style={styles.totalLabel}>Subtotal</Text><Text style={styles.totalValue}>{money(subtotal, currency)}</Text></View>
            <View style={styles.totalRow}><Text style={styles.totalLabel}>Tax</Text><Text style={styles.totalValue}>{money(tax, currency)}</Text></View>
            <View style={styles.totalDivider} />
            <View style={styles.totalRow}><Text style={styles.grandTotalLabel}>Total</Text><Text style={styles.grandTotalValue}>{money(total, currency)}</Text></View>
          </View>
          <Pressable accessibilityRole="button" disabled={busy || items.length === 0} onPress={onPay} style={({ pressed }) => [styles.payButton, pressed && styles.pressed, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color={colors.white} /> : <><Check size={19} color={colors.white} /><Text style={styles.payButtonText}>Complete cash sale</Text><Text style={styles.payButtonAmount}>{money(total, currency)}</Text></>}
          </Pressable>
          <View style={styles.cashNote}><CloudUpload size={13} color={colors.green} /><Text style={styles.cashNoteText}>Cash · {online ? 'saved on this device · sync on reconnect or from Settings' : 'saved securely until you reconnect'}</Text></View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.canvas },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
  loadingSpinner: { marginTop: 22 },
  loadingText: { color: colors.muted, marginTop: 12, fontSize: 14, fontWeight: '500' },
  loginScreen: { flex: 1, backgroundColor: colors.canvas },
  loginHero: { minHeight: 315, paddingHorizontal: 28, paddingTop: 34, paddingBottom: 30, justifyContent: 'flex-end', overflow: 'hidden' },
  loginGlow: { position: 'absolute', width: 300, height: 300, borderRadius: 150, top: -125, right: -75, backgroundColor: 'rgba(206,239,117,0.10)' },
  loginEyebrow: { color: colors.lime, letterSpacing: 2.2, fontSize: 10, fontWeight: '800', marginTop: 30, marginBottom: 11 },
  loginTitle: { color: colors.white, fontSize: 38, lineHeight: 43, fontWeight: '800', letterSpacing: -1.2 },
  loginSubtitle: { color: 'rgba(255,255,255,0.72)', marginTop: 12, fontSize: 14 },
  loginSparkle: { position: 'absolute', right: 31, bottom: 62 },
  loginFormWrap: { paddingHorizontal: 26, paddingTop: 27, flex: 1 },
  loginFormTitle: { fontSize: 23, color: colors.ink, fontWeight: '800', letterSpacing: -0.5 },
  loginFormHint: { fontSize: 13, color: colors.muted, marginTop: 5, marginBottom: 14 },
  demoRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14 },
  demoLabel: { fontSize: 12, color: colors.muted, fontWeight: '700' },
  demoChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  demoChipText: { fontSize: 12, fontWeight: '800', color: colors.green, textTransform: 'capitalize' },
  loginInput: { height: 54, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 11 },
  loginTextInput: { flex: 1, color: colors.ink, fontSize: 14 },
  loginError: { color: colors.orange, marginTop: 2, marginBottom: 10, fontSize: 13, lineHeight: 19 },
  loginButton: { height: 55, borderRadius: 17, backgroundColor: colors.green, marginTop: 5, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  loginButtonText: { color: colors.white, fontWeight: '800', fontSize: 15 },
  offlineFirst: { color: colors.muted, fontSize: 11, textAlign: 'center', marginTop: 15 },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.985 }] },
  header: { height: 65, paddingHorizontal: 21, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  brandName: { color: colors.ink, fontWeight: '900', fontSize: 19, letterSpacing: -0.8 },
  brandNameAccent: { color: colors.green, fontWeight: '600' },
  storeName: { marginTop: 1, color: colors.muted, fontSize: 8, letterSpacing: 1.3, fontWeight: '800' },
  networkPill: { height: 30, borderRadius: 99, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  networkOnline: { backgroundColor: colors.mint },
  networkOffline: { backgroundColor: colors.orangePale },
  networkText: { color: colors.green, fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  networkTextOffline: { color: colors.orange },
  scrollContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 27 },
  scrollWithCart: { paddingBottom: 26 },
  greetingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 17 },
  eyebrow: { color: colors.muted, fontSize: 9, letterSpacing: 1.6, fontWeight: '800' },
  greeting: { color: colors.ink, fontSize: 23, fontWeight: '800', letterSpacing: -0.8, marginTop: 4 },
  avatar: { width: 39, height: 39, borderRadius: 14, backgroundColor: colors.limePale, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(18,75,60,0.08)' },
  avatarText: { color: colors.green, fontSize: 15, fontWeight: '800' },
  salesHero: { minHeight: 145, borderRadius: 23, padding: 19, overflow: 'hidden', ...shadow },
  heroOrb: { position: 'absolute', width: 180, height: 180, borderRadius: 90, top: -85, right: -30, borderWidth: 1, borderColor: 'rgba(206,239,117,0.17)', backgroundColor: 'rgba(206,239,117,0.05)' },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  heroLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 9, letterSpacing: 1.4, fontWeight: '800' },
  liveTag: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.13)', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 5 },
  liveDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.lime },
  liveText: { color: colors.lime, fontSize: 8, letterSpacing: 0.8, fontWeight: '800' },
  heroAmount: { color: colors.white, fontSize: 33, letterSpacing: -1.4, fontWeight: '800', marginTop: 14 },
  heroFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  heroFootText: { color: 'rgba(255,255,255,0.72)', fontSize: 11, fontWeight: '500' },
  heroFootBadge: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  heroFootBadgeText: { color: colors.lime, fontWeight: '800', fontSize: 8, letterSpacing: 0.9 },
  feedbackBanner: { minHeight: 44, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, marginTop: 13, flexDirection: 'row', alignItems: 'center', gap: 9 },
  feedbackSuccess: { backgroundColor: colors.mint },
  feedbackError: { backgroundColor: colors.orangePale },
  feedbackText: { color: colors.green, fontSize: 11, lineHeight: 16, flex: 1, fontWeight: '600' },
  feedbackErrorText: { color: colors.orange },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, marginBottom: 13 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', letterSpacing: -0.45 },
  sectionHint: { marginTop: 3, color: colors.muted, fontSize: 11 },
  catalogBadge: { borderRadius: 9, paddingHorizontal: 9, paddingVertical: 7, backgroundColor: colors.mint, flexDirection: 'row', alignItems: 'center', gap: 5 },
  catalogBadgeText: { color: colors.green, fontSize: 8, letterSpacing: 0.7, fontWeight: '900' },
  searchBar: { height: 48, borderRadius: 15, backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 14 },
  searchInput: { flex: 1, fontSize: 13, color: colors.ink },
  productGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 11 },
  productCell: { width: '48.4%' },
  productCard: { borderRadius: 18, backgroundColor: colors.white, minHeight: 157, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  productCardSelected: { borderColor: colors.greenLight },
  productCardPress: { flex: 1, padding: 12, justifyContent: 'space-between', minHeight: 157 },
  productCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  productGlyph: { height: 43, width: 43, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  productGlyphText: { color: colors.green, fontSize: 18, fontWeight: '800' },
  addProduct: { height: 29, width: 29, borderRadius: 10, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  quantityBadge: { height: 24, minWidth: 24, paddingHorizontal: 6, borderRadius: 8, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' },
  quantityBadgeText: { color: colors.white, fontSize: 11, fontWeight: '800' },
  productName: { color: colors.ink, fontSize: 12, fontWeight: '700', lineHeight: 16, minHeight: 32 },
  productSku: { color: colors.muted, fontSize: 8, letterSpacing: 0.7, fontWeight: '700', marginTop: 2 },
  productPrice: { color: colors.green, fontSize: 15, fontWeight: '900', letterSpacing: -0.2, marginTop: 11 },
  emptyState: { minHeight: 195, borderRadius: 21, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', padding: 23, marginTop: 2 },
  emptyIcon: { height: 46, width: 46, borderRadius: 16, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle: { color: colors.ink, fontWeight: '800', fontSize: 14, textAlign: 'center' },
  emptyHint: { color: colors.muted, textAlign: 'center', fontSize: 11, lineHeight: 17, marginTop: 6, maxWidth: 250 },
  outlineButton: { borderWidth: 1, borderColor: colors.greenLight, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 9, marginTop: 14 },
  outlineButtonText: { color: colors.green, fontSize: 11, fontWeight: '700' },
  catalogFootnote: { color: colors.muted, fontSize: 10, textAlign: 'center', marginTop: 17, marginBottom: 2 },
  cartDock: { position: 'absolute', left: 20, right: 20, bottom: 79 },
  cartDockButton: { height: 59, borderRadius: 18, backgroundColor: colors.green, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, gap: 10, ...shadow },
  cartCount: { width: 30, height: 30, borderRadius: 11, backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center' },
  cartCountText: { color: colors.greenDeep, fontSize: 12, fontWeight: '900' },
  cartDockTitle: { color: colors.white, flex: 1, fontSize: 13, fontWeight: '800' },
  cartDockAmount: { color: colors.white, fontSize: 13, fontWeight: '800' },
  cartDockArrow: { height: 28, width: 28, backgroundColor: colors.lime, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  tabBar: { minHeight: 68, backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 18, paddingBottom: 3 },
  tabButton: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabIcon: { width: 54, height: 29, borderRadius: 11, alignItems: 'center', justifyContent: 'center', color: colors.muted },
  tabIconActive: { backgroundColor: colors.mint },
  tabLabel: { color: colors.muted, fontSize: 9, fontWeight: '600' },
  tabLabelActive: { color: colors.green, fontWeight: '800' },
  secondaryScroll: { flexGrow: 1, paddingHorizontal: 21, paddingTop: 24, paddingBottom: 30 },
  screenTitle: { color: colors.ink, fontSize: 27, fontWeight: '900', letterSpacing: -1, marginTop: 5 },
  screenSubtitle: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 5, marginBottom: 21, maxWidth: 310 },
  activitySummary: { minHeight: 78, padding: 14, borderRadius: 19, backgroundColor: colors.white, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: colors.line, marginBottom: 24 },
  activitySummaryIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  activitySummaryLabel: { color: colors.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  activitySummaryValue: { color: colors.ink, fontSize: 13, fontWeight: '700', marginTop: 4 },
  listHeading: { color: colors.muted, fontSize: 9, letterSpacing: 1.4, fontWeight: '800', marginBottom: 11 },
  saleList: { borderRadius: 20, backgroundColor: colors.white, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.line },
  saleRow: { minHeight: 71, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  saleIcon: { width: 34, height: 34, borderRadius: 12, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  saleIconRejected: { backgroundColor: colors.orangePale },
  saleTitle: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  saleMeta: { color: colors.muted, fontSize: 9, marginTop: 4 },
  saleAmount: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  accountCard: { minHeight: 88, borderRadius: 19, backgroundColor: colors.white, padding: 15, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: colors.line, marginBottom: 25 },
  accountAvatar: { width: 47, height: 47, borderRadius: 16, backgroundColor: colors.limePale, alignItems: 'center', justifyContent: 'center' },
  accountAvatarText: { color: colors.green, fontSize: 18, fontWeight: '800' },
  accountLabel: { color: colors.muted, fontSize: 8, letterSpacing: 1, fontWeight: '800' },
  accountEmail: { color: colors.ink, fontSize: 12, fontWeight: '700', marginTop: 4 },
  accountRole: { color: colors.green, fontSize: 8, letterSpacing: 0.7, fontWeight: '800', marginTop: 4 },
  settingsCard: { borderRadius: 20, backgroundColor: colors.white, padding: 15, borderWidth: 1, borderColor: colors.line, marginBottom: 22 },
  settingRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 11 },
  settingIcon: { width: 35, height: 35, borderRadius: 12, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  settingIconOnline: { backgroundColor: colors.mint },
  settingIconOffline: { backgroundColor: colors.orangePale },
  settingTitle: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  settingHint: { color: colors.muted, fontSize: 9, lineHeight: 14, marginTop: 3 },
  stateDot: { width: 7, height: 7, borderRadius: 5, marginRight: 2 },
  stateDotOnline: { backgroundColor: colors.greenLight },
  stateDotOffline: { backgroundColor: colors.orange },
  settingDivider: { height: 1, backgroundColor: colors.line, marginVertical: 9 },
  syncButton: { height: 43, borderRadius: 13, marginTop: 14, backgroundColor: colors.green, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  syncButtonText: { color: colors.white, fontSize: 11, fontWeight: '800' },
  infoCard: { borderRadius: 18, backgroundColor: colors.mint, padding: 15, marginBottom: 18 },
  infoIcon: { width: 35, height: 35, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.64)', alignItems: 'center', justifyContent: 'center', marginBottom: 11 },
  infoTitle: { color: colors.greenDeep, fontWeight: '800', fontSize: 12 },
  infoBody: { color: colors.green, fontSize: 10, lineHeight: 16, marginTop: 5 },
  signOutButton: { height: 52, borderRadius: 15, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  signOutText: { flex: 1, fontSize: 11, color: colors.orange, fontWeight: '700' },
  versionText: { color: colors.muted, fontSize: 8, letterSpacing: 1.3, fontWeight: '700', textAlign: 'center', marginTop: 21 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalScrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(16,35,27,0.44)' },
  modalSheet: { maxHeight: '91%', backgroundColor: colors.canvas, borderTopLeftRadius: 27, borderTopRightRadius: 27, paddingHorizontal: 20, paddingTop: 10, overflow: 'hidden' },
  modalHandle: { width: 39, height: 4, borderRadius: 9, backgroundColor: '#D8DDD3', alignSelf: 'center', marginBottom: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 15 },
  modalEyebrow: { color: colors.muted, fontSize: 8, letterSpacing: 1.4, fontWeight: '800' },
  modalTitle: { color: colors.ink, fontSize: 23, fontWeight: '900', letterSpacing: -0.8, marginTop: 3 },
  closeButton: { width: 36, height: 36, borderRadius: 12, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line },
  checkoutList: { flexGrow: 0, maxHeight: 280 },
  checkoutRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  checkoutGlyph: { height: 36, width: 36, borderRadius: 12, backgroundColor: colors.limePale, alignItems: 'center', justifyContent: 'center' },
  checkoutGlyphText: { color: colors.green, fontSize: 15, fontWeight: '800' },
  checkoutName: { color: colors.ink, fontSize: 11, fontWeight: '700' },
  checkoutUnit: { color: colors.muted, fontSize: 9, marginTop: 3 },
  quantityControls: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  quantityControl: { width: 27, height: 27, borderRadius: 9, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  checkoutQuantity: { color: colors.ink, fontSize: 11, fontWeight: '800', minWidth: 12, textAlign: 'center' },
  checkoutLineTotal: { color: colors.ink, fontSize: 10, fontWeight: '800', minWidth: 58, textAlign: 'right' },
  checkoutTotals: { paddingTop: 14, paddingBottom: 10, gap: 8 },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  totalLabel: { color: colors.muted, fontSize: 11 },
  totalValue: { color: colors.ink, fontSize: 11, fontWeight: '600' },
  totalDivider: { height: 1, backgroundColor: colors.line, marginVertical: 2 },
  grandTotalLabel: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  grandTotalValue: { color: colors.green, fontSize: 19, fontWeight: '900', letterSpacing: -0.5 },
  payButton: { minHeight: 53, borderRadius: 16, backgroundColor: colors.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingHorizontal: 14 },
  payButtonText: { color: colors.white, fontSize: 12, fontWeight: '800', flex: 1 },
  payButtonAmount: { color: colors.lime, fontSize: 12, fontWeight: '800' },
  cashNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 11, paddingBottom: 8 },
  cashNoteText: { color: colors.muted, fontSize: 9 },
});
