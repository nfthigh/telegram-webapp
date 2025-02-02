/**************************************************
 * bot.js
 **************************************************/
const express = require('express')
const { Telegraf, Markup } = require('telegraf')
const axios = require('axios')
const path = require('path')
const dotenv = require('dotenv')
const LocalSession = require('telegraf-session-local')
const crypto = require('crypto')
const fs = require('fs')
const morgan = require('morgan') // Логирование HTTP-запросов
const cron = require('node-cron') // Пакет для cron‑заданий

dotenv.config() // Загрузить .env

// Глобальный объект для хранения имен клиентов (если требуется)
const clients = {}

// Файл для заказов бота (отдельный от заказов WooCommerce)
const botOrdersFile = path.join(__dirname, 'bot_orders.json')

// Загружаем заказы бота (если есть)
let botOrders = {}
try {
	if (fs.existsSync(botOrdersFile)) {
		botOrders = JSON.parse(fs.readFileSync(botOrdersFile, 'utf8'))
		console.log('Заказы бота загружены из файла')
	}
} catch (err) {
	console.error('Ошибка загрузки bot_orders:', err)
}

// Функция сохранения заказов бота
function saveBotOrders() {
	try {
		fs.writeFileSync(botOrdersFile, JSON.stringify(botOrders, null, 2))
		console.log('Заказы бота сохранены в файл')
	} catch (err) {
		console.error('Ошибка сохранения bot_orders:', err)
	}
}

// Файл для заказов WooCommerce (если требуется)
const ordersFile = path.join(__dirname, 'orders.json')
let orders = {}
try {
	if (fs.existsSync(ordersFile)) {
		orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'))
		console.log('Заказы загружены из файла')
	}
} catch (err) {
	console.error('Ошибка загрузки orders:', err)
}
function saveOrders() {
	try {
		fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2))
		console.log('Заказы сохранены в файл')
	} catch (err) {
		console.error('Ошибка сохранения orders:', err)
	}
}

// Папка для сохранения корзин
const cartsDir = path.join(__dirname, 'carts')
if (!fs.existsSync(cartsDir)) {
	fs.mkdirSync(cartsDir)
	console.log('Папка carts создана')
}

// Инициализация Express
const app = express()
const PORT = process.env.PORT || 3000

app.use(morgan('dev'))
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// Инициализация Telegram-бота
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)
const localSession = new LocalSession({ database: 'session_db.json' })
bot.use(localSession.middleware())

/*************************************************
 * 1) Billz: JWT, /api/products, /api/categories
 *************************************************/
async function getJwtToken() {
	try {
		const resp = await axios.post(
			process.env.BILLZ_AUTH_URL,
			{ secret_token: process.env.BILLZ_SECRET_TOKEN },
			{
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
			}
		)
		if (resp.status === 200) {
			const token = resp.data.data.access_token
			console.log('Получен JWT токен Billz:', token)
			return token
		} else {
			console.error('Ошибка авторизации Billz:', resp.status, resp.data)
			return null
		}
	} catch (err) {
		console.error('Ошибка при auth Billz:', err)
		return null
	}
}

let cachedProducts = null
let cacheTimestamp = null
const CACHE_DURATION = 5 * 60 * 1000

async function getAllProducts(jwt) {
	const now = Date.now()
	if (
		cachedProducts &&
		cacheTimestamp &&
		now - cacheTimestamp < CACHE_DURATION
	) {
		console.log('Возвращаем закэшированные товары (Billz).')
		return cachedProducts
	}
	try {
		let all = []
		let page = 1
		const limit = 100
		while (true) {
			const r = await axios.get(process.env.BILLZ_PRODUCTS_URL, {
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${jwt}`,
				},
				params: { page, limit },
			})
			if (r.status === 200) {
				const { products } = r.data
				if (!products || products.length === 0) break
				const filtered = products
					.filter(
						p =>
							p.shop_measurement_values &&
							p.shop_measurement_values.some(
								sm => sm.shop_id === process.env.DESIRED_SHOP_ID
							)
					)
					.map(p => {
						const shopM = p.shop_measurement_values.find(
							sm => sm.shop_id === process.env.DESIRED_SHOP_ID
						)
						const priceObj = p.shop_prices.find(
							pr =>
								pr.shop_id === process.env.DESIRED_SHOP_ID &&
								pr.retail_currency === 'UZS'
						)
						const price = priceObj ? priceObj.retail_price : 0
						return {
							id: p.id,
							sku: p.sku || '',
							name: p.name || (shopM ? shopM.name : 'Без названия'),
							brand_name: p.brand_name || 'Неизвестный бренд',
							price,
							qty: shopM ? shopM.active_measurement_value : 0,
							shop_name: shopM ? shopM.shop_name : 'Unknown Shop',
							main_image_url_full: p.main_image_url_full || '',
							photos: p.photos ? p.photos.map(ph => ph.photo_url) : [],
							categories: p.categories || [],
						}
					})
				all = [...all, ...filtered]
				console.log(`Billz page=${page}, товаров:${filtered.length}`)
				page++
			} else {
				console.error('Ошибка Billz get products:', r.status, r.data)
				break
			}
		}
		console.log(`Всего товаров Billz: ${all.length}`)
		cachedProducts = all
		cacheTimestamp = now
		return all
	} catch (err) {
		console.error('Ошибка getAllProducts Billz:', err)
		return []
	}
}

app.get('/api/products', async (req, res) => {
	console.log('GET /api/products, cat=', req.query.category)
	const jwt = await getJwtToken()
	if (!jwt) return res.status(500).json({ error: 'Billz auth error' })
	const products = await getAllProducts(jwt)
	const cat = req.query.category
	if (cat && cat !== 'Все' && cat !== 'Hammasi') {
		const filtered = products.filter(p =>
			p.categories.some(c => c.name === cat)
		)
		return res.json(filtered)
	}
	return res.json(products)
})

app.get('/api/categories', async (req, res) => {
	console.log('GET /api/categories')
	const jwt = await getJwtToken()
	if (!jwt) return res.status(500).json({ error: 'Billz auth error' })
	const products = await getAllProducts(jwt)
	const catSet = new Set()
	products.forEach(p => {
		p.categories.forEach(ct => catSet.add(ct.name))
	})
	let cats = Array.from(catSet).sort()
	if (!cats.includes('Hammasi')) cats.unshift('Hammasi')
	if (!cats.includes('Все')) cats.unshift('Все')
	res.json(cats)
})

/*************************************************
 * 2) Мультиязычность и дополнительные пункты меню
 *************************************************/
const translations = {
	ru: {
		select_language: 'Выберите язык:',
		start: 'Привет! Как вас зовут? 😊',
		ask_contact:
			'Приятно познакомиться, {{name}}! Отправьте, пожалуйста, свой контакт для продолжения.',
		contact_saved:
			'Спасибо, {{name}}! Ваш номер {{phone}} сохранен. Нажмите "📚 Каталог", чтобы начать.',
		contact_error: 'Пожалуйста, отправьте свой контакт.',
		please_enter_name: 'Пожалуйста, введите ваше имя. ✍️',
		catalog: '📚 Каталог',
		cart: '🛒 Корзина',
		orders: '📦 Заказы',
		my_data: '📝 Мои данные',
		open_catalog: 'Открыть каталог',
		cart_empty: 'Корзина пуста.',
		orders_unavailable: 'У вас пока нет заказов.',
		added_to_cart: '✅ Товар {{name}} добавлен в корзину.',
		invalid_data: '❌ Неверные данные.',
		language_changed: 'Язык изменен.',
		my_cart: '🛒 Ваша корзина',
		total: '💰 Итого',
		checkout: 'Оформить заказ',
		order_success: '🎉 Ваш заказ оплачен!',
		order_canceled: '❌ Заказ отменен.',
		order_created:
			'📦 Заказ №{{merchant_trans_id}}\n💰 Сумма: {{amount}} UZS\n🔗 Оплатите по ссылке:\n{{url}}',
		order_error: '❌ Ошибка: {{error}}',
		payment_request: 'Пожалуйста, оплатите заказ по ссылке:',
		order_empty: 'Нет заказов.',
		switch_language: 'Сменить язык',
		welcome:
			'Добро пожаловать, {{name}}! 👋\nЧем мы можем вам помочь? Выберите нужное действие:',
		my_data_text: 'Вот ваши данные:\nИмя: {{name}}\nТелефон: {{phone}}',
		change_name: 'Изменить имя',
		change_phone: 'Изменить номер',
		clear_orders: 'Очистить заказы',
		back: 'Назад',
	},
	uz: {
		select_language: 'Tilni tanlang:',
		start: 'Salom! Ismingiz nima? 😊',
		ask_contact:
			'Siz bilan tanishganimdan xursandman, {{name}}! Iltimos, kontakt raqamingizni yuboring.',
		contact_saved:
			'Rahmat, {{name}}! Sizning raqamingiz {{phone}} saqlandi. "📚 Katalog" tugmasini bosing.',
		contact_error: 'Iltimos, kontakt yuboring.',
		please_enter_name: 'Iltimos, ismingizni kiriting. ✍️',
		catalog: '📚 Katalog',
		cart: '🛒 Savat',
		orders: '📦 Buyurtmalar',
		my_data: '📝 Mening ma’lumotlarim',
		open_catalog: 'Katalogni ochish',
		cart_empty: "Savat bo'sh.",
		orders_unavailable: "Buyurtmangiz hali yo'q.",
		added_to_cart: "✅ Mahsulot {{name}} savatga qo'shildi.",
		invalid_data: "❌ Noto'g'ri ma'lumotlar.",
		language_changed: "Til o'zgartirildi.",
		my_cart: '🛒 Mening savatim',
		total: '💰 Jami',
		checkout: 'Buyurtma berish',
		order_success: "🎉 Buyurtmangiz to'landi!",
		order_canceled: '❌ Buyurtma bekor qilindi.',
		order_created:
			"📦 Buyurtma №{{merchant_trans_id}}\n💰 Jami: {{amount}} UZS\n🔗 Iltimos, to'lang:\n{{url}}",
		order_error: '❌ Xato: {{error}}',
		payment_request: "Iltimos, quyidagi havola orqali to'lang:",
		order_empty: "Buyurtmalar yo'q.",
		switch_language: "Tilni o'zgartirish",
		welcome:
			"Xush kelibsiz, {{name}}! 👋\nSizga qanday yordam bera olamiz? Kerakli bo'limni tanlang:",
		my_data_text:
			"Sizning ma'lumotlaringiz:\nIsm: {{name}}\nTelefon: {{phone}}",
		change_name: "Ismni o'zgartirish",
		change_phone: "Telefon raqamini o'zgartirish",
		clear_orders: 'Buyurtmalarni tozalash',
		back: 'Orqaga',
	},
}

/*************************************************
 * 3) Telegram-бот: Основное меню и меню "Мои данные"
 *************************************************/
// Функция для показа главного меню с приветствием (reply keyboard)
function sendMainMenu(ctx) {
	const lang = ctx.session.language || 'ru'
	ctx.session.state = 'MENU'
	const welcomeMsg = translations[lang].welcome.replace(
		'{{name}}',
		ctx.session.name
	)
	ctx.reply(
		welcomeMsg,
		Markup.keyboard([
			[translations[lang].catalog, translations[lang].cart],
			[translations[lang].orders, translations[lang].my_data],
			[`🔄 ${translations[lang].switch_language}`],
		]).resize()
	)
}

// Функция для показа меню "Мои данные" (inline keyboard)
function sendMyData(ctx) {
	const lang = ctx.session.language || 'ru'
	ctx.session.state = 'MY_DATA'
	const dataMsg = translations[lang].my_data_text
		.replace('{{name}}', ctx.session.name || '—')
		.replace('{{phone}}', ctx.session.contact || '—')
	ctx.reply(
		dataMsg,
		Markup.inlineKeyboard([
			[Markup.button.callback(translations[lang].change_name, 'edit_name')],
			[Markup.button.callback(translations[lang].change_phone, 'edit_phone')],
			[Markup.button.callback(translations[lang].clear_orders, 'clear_orders')],
			[Markup.button.callback(translations[lang].back, 'back_to_menu')],
		])
	)
}

bot.start(async ctx => {
	console.log(`User ${ctx.from.id} запустил /start`)
	if (ctx.session.name) {
		sendMainMenu(ctx)
	} else {
		ctx.session.state = 'SELECT_LANGUAGE'
		ctx.session.cart = []
		await ctx.reply(
			translations.ru.select_language,
			Markup.inlineKeyboard([
				Markup.button.callback('Русский 🇷🇺', 'lang_ru'),
				Markup.button.callback("O'zbek 🇺🇿", 'lang_uz'),
			])
		)
	}
})

bot.action(/lang_(ru|uz)/, async ctx => {
	const selectedLang = ctx.match[1]
	if (['ru', 'uz'].includes(selectedLang)) {
		ctx.session.language = selectedLang
		if (ctx.session.name) {
			sendMainMenu(ctx)
		} else {
			ctx.session.state = 'INPUT_NAME'
			await ctx.reply(translations[selectedLang].start)
			await ctx.reply(translations[selectedLang].please_enter_name)
		}
		await ctx.answerCbQuery()
	} else {
		await ctx.answerCbQuery('Неверный выбор языка.')
	}
})

// Обработка inline-кнопок из меню "Мои данные"
bot.action('edit_name', async ctx => {
	ctx.session.state = 'EDIT_NAME'
	await ctx.answerCbQuery()
	await ctx.reply('Введите новое имя:')
})
bot.action('edit_phone', async ctx => {
	ctx.session.state = 'EDIT_PHONE'
	await ctx.answerCbQuery()
	await ctx.reply('Введите новый номер телефона:')
})
bot.action('clear_orders', async ctx => {
	try {
		const resp = await axios.post(`${process.env.WEBAPP_URL}/clear-orders`, {
			chat_id: ctx.from.id,
		})
		if (resp.data.success) {
			await ctx.answerCbQuery('Заказы очищены.')
		} else {
			await ctx.answerCbQuery('Ошибка очистки заказов.')
		}
	} catch (e) {
		console.error('Ошибка при очистке заказов:', e)
		await ctx.answerCbQuery('Ошибка очистки заказов.')
	}
})
bot.action('back_to_menu', async ctx => {
	await ctx.answerCbQuery()
	sendMainMenu(ctx)
})

bot.on('text', async ctx => {
	if (ctx.session.state === 'INPUT_NAME') {
		const name = ctx.message.text.trim()
		if (name) {
			ctx.session.name = name
			clients[ctx.from.id] = name
			ctx.session.state = 'AWAIT_CONTACT'
			await ctx.reply(
				translations[ctx.session.language].ask_contact.replace(
					'{{name}}',
					name
				),
				Markup.keyboard([
					Markup.button.contactRequest('📱 Отправить контакт'),
				]).resize()
			)
		} else {
			await ctx.reply(translations[ctx.session.language].please_enter_name)
		}
	} else if (ctx.session.state === 'EDIT_NAME') {
		const newName = ctx.message.text.trim()
		if (newName) {
			ctx.session.name = newName
			await ctx.reply(`Имя изменено на ${newName}.`)
			sendMyData(ctx)
		} else {
			await ctx.reply('Введите корректное имя.')
		}
	} else if (ctx.session.state === 'EDIT_PHONE') {
		const newPhone = ctx.message.text.trim()
		if (newPhone) {
			ctx.session.contact = newPhone
			await ctx.reply(`Номер телефона изменён на ${newPhone}.`)
			sendMyData(ctx)
		} else {
			await ctx.reply('Введите корректный номер.')
		}
	} else if (ctx.session.state === 'MENU') {
		const msg = ctx.message.text
		const lang = ctx.session.language || 'ru'
		if (msg === translations.ru.catalog || msg === translations.uz.catalog) {
			const webAppUrl = `${process.env.WEBAPP_URL}?lang=${lang}&chat_id=${
				ctx.from.id
			}&phone=${ctx.session.contact || ''}`
			await ctx.reply(
				translations[lang].open_catalog,
				Markup.inlineKeyboard([
					[Markup.button.webApp(translations[lang].open_catalog, webAppUrl)],
				])
			)
		} else if (msg === translations.ru.cart || msg === translations.uz.cart) {
			try {
				const resp = await axios.get(`${process.env.WEBAPP_URL}/get-car`, {
					params: { chat_id: ctx.from.id },
				})
				const userCart = resp.data.cart
				if (userCart && userCart.length > 0) {
					let txt =
						lang === 'ru'
							? '🛒 <b>Ваша корзина:</b>\n\n'
							: '🛒 <b>Mening savatim:</b>\n\n'
					userCart.forEach((item, i) => {
						txt += `📌 <b>${i + 1}. ${item.name}</b>\nКол-во: ${
							item.quantity
						}\nЦена: ${item.price} UZS\n-----------------\n`
					})
					await ctx.replyWithHTML(txt)
				} else {
					await ctx.reply(
						lang === 'ru'
							? translations[lang].cart_empty
							: translations[lang].cart_empty
					)
				}
			} catch (err) {
				console.error('Ошибка получения корзины:', err)
				await ctx.reply(
					lang === 'ru'
						? translations[lang].cart_empty
						: translations[lang].cart_empty
				)
			}
		} else if (
			msg === translations.ru.orders ||
			msg === translations.uz.orders
		) {
			const userOrders = Object.values(botOrders).filter(
				o => String(o.chat_id) === String(ctx.from.id)
			)
			if (userOrders.length > 0) {
				let txt =
					lang === 'ru'
						? '📦 <b>Ваши заказы:</b>\n\n'
						: '📦 <b>Mening buyurtmalarim:</b>\n\n'
				userOrders.forEach(ord => {
					let statusText = ''
					switch (ord.status) {
						case 'CREATED':
							statusText = 'В очереди'
							break
						case 'PAID':
							statusText = 'Оплачен'
							break
						case 'CANCELED':
							statusText = 'Отменён'
							break
						default:
							statusText = ord.status
					}
					txt += `✅ <b>Заказ №${ord.merchant_trans_id}</b>\n💰 Сумма: ${ord.totalAmount} UZS\n📌 Статус: ${statusText}\n🛍️ Товары:\n`
					ord.cart.forEach((item, idx) => {
						txt += `   ${idx + 1}. ${item.name} x ${item.quantity} шт. - ${
							item.price * item.quantity
						} UZS\n`
					})
					txt += `\n-----------------------\n`
				})
				const messages = txt.match(/[\s\S]{1,4000}/g)
				for (const m of messages) {
					await ctx.replyWithHTML(m)
				}
			} else {
				await ctx.reply(
					lang === 'ru'
						? translations[lang].order_empty
						: translations[lang].order_empty
				)
			}
		} else if (msg.toLowerCase().includes('мои данные')) {
			sendMyData(ctx)
		} else if (msg.startsWith('🔄')) {
			const newLang = lang === 'ru' ? 'uz' : 'ru'
			ctx.session.language = newLang
			await ctx.reply(
				`Язык изменён на ${newLang === 'ru' ? 'Русский' : "O'zbek"}.`
			)
			sendMainMenu(ctx)
		} else {
			await ctx.reply(
				lang === 'uz'
					? "Noma'lum buyruq. Iltimos, tugmalarni ishlating."
					: 'Неизвестная команда. Пожалуйста, используйте кнопки.'
			)
		}
	}
})

bot.on('contact', async ctx => {
	if (ctx.session.state !== 'AWAIT_CONTACT') return
	const contact = ctx.message.contact
	if (contact && contact.phone_number) {
		ctx.session.contact = contact.phone_number
		ctx.session.state = 'MENU'
		if (!clients[ctx.from.id] && ctx.session.name) {
			clients[ctx.from.id] = ctx.session.name
		}
		sendMainMenu(ctx)
	} else {
		await ctx.reply(translations[ctx.session.language].contact_error)
	}
})

bot.on('web_app_data', async ctx => {
	const lang = ctx.session.language || 'ru'
	try {
		const d = JSON.parse(ctx.message.web_app_data.data)
		if (d.action === 'updateCart' && Array.isArray(d.cart)) {
			ctx.session.cart = d.cart
			await ctx.reply(
				lang === 'ru' ? '📝 Корзина обновлена.' : '📝 Savat yangilandi.'
			)
		} else if (d.action === 'add' && d.product) {
			if (!ctx.session.cart) ctx.session.cart = []
			const existing = ctx.session.cart.find(it => it.id === d.product.id)
			const qty = d.quantity || 1
			if (existing) {
				existing.quantity += qty
			} else {
				ctx.session.cart.push({
					id: d.product.id,
					sku: d.product.sku,
					name: d.product.name,
					price: d.product.price,
					quantity: qty,
					qty: d.product.qty,
				})
			}
			await ctx.reply(
				lang === 'ru'
					? `✅ Товар "${d.product.name}" добавлен в корзину.`
					: `✅ Mahsulot "${d.product.name}" savatga qo'shildi.`
			)
		} else if (d.action === 'remove' && d.product) {
			if (ctx.session.cart) {
				const index = ctx.session.cart.findIndex(it => it.id === d.product.id)
				if (index !== -1) {
					ctx.session.cart.splice(index, 1)
					await ctx.reply(
						lang === 'ru'
							? `❌ Товар "${d.product.name}" удалён из корзины.`
							: `❌ Mahsulot "${d.product.name}" savatdan olib tashlandi.`
					)
				}
			}
		} else {
			await ctx.reply(
				lang === 'ru'
					? translations[lang].invalid_data
					: translations[lang].invalid_data
			)
		}
	} catch (e) {
		console.error('Ошибка web_app_data:', e)
		await ctx.reply(
			lang === 'ru'
				? 'Произошла ошибка при обработке данных.'
				: "Ma'lumotlarni qayta ishlashda xatolik yuz berdi."
		)
	}
})

bot.command('language', async ctx => {
	ctx.session.state = 'SELECT_LANGUAGE'
	await ctx.reply(
		translations[ctx.session.language || 'ru'].select_language,
		Markup.inlineKeyboard([
			Markup.button.callback('Русский 🇷🇺', 'lang_ru'),
			Markup.button.callback("O'zbek 🇺🇿", 'lang_uz'),
		])
	)
})

bot.on('message', async ctx => {
	console.log(`Unhandled message from user ${ctx.from.id}:`, ctx.message.text)
})

/*************************************************
 * 4) CLICK-интеграция
 * Метод оплаты через сайт WooCommerce с платежной системой clickuz
 * (без создания инвойса через Click API)
 * Используем данные клиента (имя, телефон) из запроса/сессии.
 *************************************************/
app.post('/create-click-order', async (req, res) => {
	console.log('📨 POST /create-click-order, body=', req.body)
	const { chat_id, cart, phone_number, lang } = req.body
	if (
		!chat_id ||
		!cart ||
		!Array.isArray(cart) ||
		cart.length === 0 ||
		!phone_number
	) {
		return res
			.status(400)
			.json({ success: false, error: 'Некорректные данные' })
	}
	const clientName = req.body.name || 'Пользователь'
	let lineItems = []
	let totalAmount = 0
	for (const item of cart) {
		if (!item.sku) {
			console.warn(`[Click] Товар без SKU: ${item.name}`)
			continue
		}
		const wooProd = await findWooProductBySku(item.sku)
		if (!wooProd) continue
		lineItems.push({
			product_id: wooProd.id,
			quantity: item.quantity,
		})
		totalAmount += item.price * item.quantity
	}
	if (lineItems.length === 0) {
		return res
			.status(400)
			.json({ success: false, error: 'Нет товаров для Click заказа' })
	}
	console.log(`[Click] totalAmount (UZS)=${totalAmount}`)
	const orderData = {
		payment_method: 'clickuz',
		payment_method_title: 'CLICK',
		set_paid: false,
		billing: {
			first_name: clientName,
			last_name: ' ',
			email: 'client@example.com',
			phone: phone_number,
			address_1: 'Адрес',
			address_2: '',
			city: 'Tashkent',
			state: 'Tashkent',
			postcode: '100000',
			country: 'UZ',
		},
		line_items: lineItems,
	}
	try {
		const wcResp = await axios.post(
			`${process.env.WC_API_URL}/orders`,
			orderData,
			{
				auth: {
					username: process.env.WC_CONSUMER_KEY,
					password: process.env.WC_CONSUMER_SECRET,
				},
			}
		)
		const wcOrder = wcResp.data
		const order_id = wcOrder.id
		const order_key = wcOrder.order_key
		const wcTotal = parseFloat(wcOrder.total || '0')
		console.log(
			`[Click] WooCommerce заказ #${order_id}, order_key=${order_key}, total=${wcTotal}`
		)
		const siteUrl = process.env.WC_SITE_URL || 'https://mrclub.uz'
		const payUrl = `${siteUrl}/checkout/order-pay/${order_id}/?key=${order_key}&order_pay=${order_id}`
		const merchant_trans_id = `click_${Date.now()}`
		botOrders[merchant_trans_id] = {
			chat_id,
			cart,
			totalAmount,
			wc_order_id: order_id,
			wc_order_key: order_key,
			status: 'CREATED', // "В очереди"
			lang: lang || 'ru',
			merchant_trans_id,
		}
		saveBotOrders()
		try {
			const txt = translations[botOrders[merchant_trans_id].lang].order_created
				.replace('{{merchant_trans_id}}', merchant_trans_id)
				.replace('{{amount}}', totalAmount)
				.replace('{{url}}', payUrl)
			await bot.telegram.sendMessage(chat_id, txt)
		} catch (e) {
			console.error('Ошибка Telegram (Click):', e)
		}
		return res.json({ success: true, clickLink: payUrl })
	} catch (e) {
		console.error(
			'[Click] Ошибка WooCommerce (create order):',
			e.response?.data || e.message
		)
		return res
			.status(500)
			.json({ success: false, error: 'Ошибка при создании заказа WooCommerce' })
	}
})

/*************************************************
 * 5) Payme: Пропуск первой страницы (аналогично)
 *************************************************/
async function findWooProductBySku(sku) {
	console.log('[Payme] findWooProductBySku:', sku)
	try {
		const url = `${process.env.WC_API_URL}/products`
		const resp = await axios.get(url, {
			auth: {
				username: process.env.WC_CONSUMER_KEY,
				password: process.env.WC_CONSUMER_SECRET,
			},
			params: { sku },
		})
		if (Array.isArray(resp.data) && resp.data.length > 0) {
			console.log('[Payme] Товар по SKU найден:', resp.data[0].name)
			return resp.data[0]
		}
		console.warn('[Payme] SKU не найден:', sku)
		return null
	} catch (e) {
		console.error('[Payme] Ошибка findWooProductBySku:', e)
		return null
	}
}

app.post('/create-payme-order', async (req, res) => {
	console.log('📨 POST /create-payme-order, body=', req.body)
	const { chat_id, cart, phone_number, lang } = req.body
	if (
		!chat_id ||
		!cart ||
		!Array.isArray(cart) ||
		cart.length === 0 ||
		!phone_number
	) {
		return res
			.status(400)
			.json({ success: false, error: 'Некорректные данные' })
	}
	let lineItems = []
	let totalAmount = 0
	for (const item of cart) {
		if (!item.sku) {
			console.warn(`[Payme] Товар без SKU: ${item.name}`)
			continue
		}
		const wooProd = await findWooProductBySku(item.sku)
		if (!wooProd) continue
		lineItems.push({
			product_id: wooProd.id,
			quantity: item.quantity,
		})
		totalAmount += item.price * item.quantity
	}
	if (lineItems.length === 0) {
		return res
			.status(400)
			.json({ success: false, error: 'Нет товаров для Payme заказа' })
	}
	console.log(`[Payme] totalAmount (UZS)=${totalAmount}`)
	const orderData = {
		payment_method: 'payme',
		payment_method_title: 'Payme',
		set_paid: false,
		billing: {
			first_name: 'Тест',
			last_name: 'Клиент',
			address_1: 'Тестовый адрес',
			city: 'Tashkent',
			state: 'Tashkent',
			postcode: '100000',
			country: 'UZ',
			email: 'test@example.com',
			phone: phone_number,
		},
		line_items: lineItems,
	}
	try {
		const wcResp = await axios.post(
			`${process.env.WC_API_URL}/orders`,
			orderData,
			{
				auth: {
					username: process.env.WC_CONSUMER_KEY,
					password: process.env.WC_CONSUMER_SECRET,
				},
			}
		)
		const wcOrder = wcResp.data
		const order_id = wcOrder.id
		const order_key = wcOrder.order_key
		const wcTotal = parseFloat(wcOrder.total || '0')
		console.log(
			`[Payme] WooCommerce заказ #${order_id}, order_key=${order_key}, total=${wcTotal}`
		)
		const siteUrl = process.env.WC_SITE_URL || 'https://mrclub.uz'
		const payUrl = `${siteUrl}/checkout/order-pay/${order_id}/?key=${order_key}&order_pay=${order_id}`
		const merchant_trans_id = `payme_${Date.now()}`
		botOrders[merchant_trans_id] = {
			chat_id,
			cart,
			totalAmount,
			wc_order_id: order_id,
			wc_order_key: order_key,
			status: 'CREATED', // "В очереди"
			lang: lang || 'ru',
			merchant_trans_id,
		}
		saveBotOrders()
		try {
			const textMsg = `Заказ №${merchant_trans_id}\nСумма: ${wcTotal} UZS\nОплатить:\n${payUrl}`
			await bot.telegram.sendMessage(chat_id, textMsg)
		} catch (e) {
			console.error('Ошибка Telegram при отправке Payme ссылки:', e)
		}
		return res.json({ success: true, paymeLink: payUrl })
	} catch (e) {
		console.error(
			'[Payme] Ошибка WooCommerce (create order):',
			e.response?.data || e.message
		)
		return res
			.status(500)
			.json({ success: false, error: 'Ошибка при создании заказа WooCommerce' })
	}
})

/*************************************************
 * ENDPOINT: Сохранение корзины в файл (POST /save-cart)
 *************************************************/
app.post('/save-cart', (req, res) => {
	const { chat_id, cart } = req.body
	if (!chat_id || !cart) {
		return res
			.status(400)
			.json({ success: false, error: 'Некорректные данные' })
	}
	const filePath = path.join(cartsDir, `cart_${chat_id}.json`)
	try {
		fs.writeFileSync(filePath, JSON.stringify(cart, null, 2))
		return res.json({ success: true })
	} catch (err) {
		console.error('Ошибка сохранения корзины:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

/*************************************************
 * ENDPOINT: Получение корзины из файла (GET /get-car)
 *************************************************/
app.get('/get-car', (req, res) => {
	const chat_id = req.query.chat_id
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const filePath = path.join(cartsDir, `cart_${chat_id}.json`)
	if (fs.existsSync(filePath)) {
		try {
			const cartData = fs.readFileSync(filePath, 'utf8')
			const cart = JSON.parse(cartData)
			return res.json({ success: true, cart })
		} catch (err) {
			console.error('Ошибка чтения корзины:', err)
			return res.status(500).json({ success: false, error: 'Ошибка сервера' })
		}
	} else {
		return res.json({ success: true, cart: [] })
	}
})

/*************************************************
 * ENDPOINT: Получение заказов для пользователя (GET /get-orders)
 *************************************************/
app.get('/get-orders', (req, res) => {
	const chat_id = req.query.chat_id
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const userOrders = Object.values(botOrders).filter(
		o => String(o.chat_id) === String(chat_id)
	)
	const ordersWithStatus = userOrders.map(o => {
		let statusText = ''
		switch (o.status) {
			case 'CREATED':
				statusText = 'В очереди'
				break
			case 'PAID':
				statusText = 'Оплачен'
				break
			case 'CANCELED':
				statusText = 'Отменён'
				break
			default:
				statusText = o.status
		}
		return { ...o, statusText }
	})
	return res.json({ success: true, orders: ordersWithStatus })
})

/*************************************************
 * ENDPOINT: Очистка заказов для пользователя (POST /clear-orders)
 *************************************************/
app.post('/clear-orders', (req, res) => {
	const { chat_id } = req.body
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const initialCount = Object.keys(botOrders).length
	botOrders = Object.fromEntries(
		Object.entries(botOrders).filter(
			([key, order]) => String(order.chat_id) !== String(chat_id)
		)
	)
	saveBotOrders()
	const finalCount = Object.keys(botOrders).length
	return res.json({
		success: true,
		message: `Заказы очищены. Было ${initialCount}, осталось ${finalCount}`,
	})
})

/*************************************************
 * Self-ping: предотвращение простоя на Render.com
 *************************************************/
// Если переменная RENDER_EXTERNAL_URL задана, запускаем cron-задачу
if (process.env.RENDER_EXTERNAL_URL) {
	cron.schedule('*/10 * * * *', async () => {
		try {
			// Посылаем GET-запрос к главной странице вашего приложения
			await axios.get(process.env.RENDER_EXTERNAL_URL)
			console.log('Self-ping: приложение активно.')
		} catch (error) {
			console.error('Self-ping: ошибка запроса:', error.message)
		}
	})
}

/*************************************************
 * Запуск сервера и Telegram-бота
 *************************************************/
app.listen(PORT, () => {
	console.log(`🚀 Сервер запущен на порту ${PORT}`)
})

bot
	.launch()
	.then(() => console.log('Telegram-бот запущен'))
	.catch(err => console.error('Ошибка запуска Telegram-бота:', err))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
