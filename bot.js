/**************************************************
 * bot.js — Файл с PostgreSQL, Express-сервером и Telegram-ботом
 **************************************************/

const express = require('express')
const { Telegraf, Markup } = require('telegraf')
const axios = require('axios')
const path = require('path')
const dotenv = require('dotenv')
const LocalSession = require('telegraf-session-local')
const morgan = require('morgan')
const cron = require('node-cron')
const { Pool } = require('pg') // Подключаем PostgreSQL

dotenv.config()

// ***********************
// ИНИЦИАЛИЗАЦИЯ ПУЛА PostgreSQL
// ***********************
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl:
		process.env.NODE_ENV === 'production'
			? { rejectUnauthorized: false }
			: false,
})

pool
	.connect()
	.then(client => {
		console.log('Подключение к PostgreSQL успешно установлено')
		client.release()
	})
	.catch(err => console.error('Ошибка подключения к PostgreSQL:', err))

// ***********************
// Создание таблиц (если не существуют)
// ***********************
const createTables = async () => {
	try {
		await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        language TEXT,
        last_activity TIMESTAMP
      )
    `)
		await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        merchant_trans_id TEXT,
        chat_id TEXT,
        totalAmount INTEGER,
        status TEXT,
        lang TEXT,
        cart JSONB,
        wc_order_id INTEGER,
        wc_order_key TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
		await pool.query(`
      CREATE TABLE IF NOT EXISTS carts (
        chat_id TEXT PRIMARY KEY,
        cart JSONB
      )
    `)
		console.log('Таблицы PostgreSQL успешно созданы или уже существуют.')
	} catch (err) {
		console.error('Ошибка при создании таблиц:', err)
	}
}
createTables()

// ***********************
// Функции для работы с пользователями
// ***********************
async function getUser(chatId) {
	try {
		const result = await pool.query('SELECT * FROM users WHERE chat_id = $1', [
			chatId,
		])
		return result.rows[0] || null
	} catch (err) {
		console.error('Ошибка получения пользователя:', err)
		return null
	}
}

async function updateLastActivity(chatId) {
	try {
		await pool.query(
			'UPDATE users SET last_activity = CURRENT_TIMESTAMP WHERE chat_id = $1',
			[chatId]
		)
	} catch (err) {
		console.error('Ошибка обновления last_activity:', err)
	}
}

// ***********************
// ИНИЦИАЛИЗАЦИЯ EXPRESS-СЕРВЕРА
// ***********************
const app = express()
const PORT = process.env.PORT || 3000
app.use(morgan('dev'))
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ***********************
// ИНИЦИАЛИЗАЦИЯ TELEGRAM-БОТА
// ***********************
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)
const localSession = new LocalSession({ database: 'session_db.json' })
bot.use(localSession.middleware())

// ***********************
// Middleware для проверки регистрации и обновления last_activity
// ***********************
bot.use(async (ctx, next) => {
	if (ctx.from && ctx.from.id) {
		const user = await getUser(ctx.from.id)
		if (user) {
			// Если пользователь найден в базе, синхронизируем с сессией
			ctx.session.name = user.name
			ctx.session.contact = user.phone
			ctx.session.language = user.language
			await updateLastActivity(ctx.from.id)
		} else {
			// Если в базе нет записи, сбрасываем сессию (чтобы пройти регистрацию заново)
			ctx.session = {}
		}
	}
	return next()
})

// ***********************
// 1) Интеграция с Billz (получение JWT, товаров, категорий)
// ***********************
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
				console.log(`Billz page=${page}, товаров: ${filtered.length}`)
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
	products.forEach(p => p.categories.forEach(ct => catSet.add(ct.name)))
	let cats = Array.from(catSet).sort()
	if (!cats.includes('Hammasi')) cats.unshift('Hammasi')
	if (!cats.includes('Все')) cats.unshift('Все')
	res.json(cats)
})

// ***********************
// 2) Мультиязычность и меню бота
// ***********************
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
		catalog: '📚 Кaталог',
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

// ***********************
// Обработка команды /start с проверкой в базе
// ***********************
bot.start(async ctx => {
	try {
		const user = await getUser(ctx.from.id)
		if (user) {
			// Пользователь найден — синхронизируем с сессией и показываем меню
			ctx.session.name = user.name
			ctx.session.contact = user.phone
			ctx.session.language = user.language
			sendMainMenu(ctx)
		} else {
			// Если данных в базе нет, начинаем регистрацию
			ctx.session = {}
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
	} catch (err) {
		console.error('Ошибка при обработке /start:', err)
		ctx.session = {}
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
	try {
		await ctx.answerCbQuery()
	} catch (error) {
		console.error('Ошибка при ответе на callback query:', error)
	}
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
	} else {
		await ctx.reply('Неверный выбор языка.')
	}
})

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
	const chat_id = ctx.from.id
	const query = `DELETE FROM orders WHERE chat_id = $1`
	try {
		await pool.query(query, [chat_id])
		await ctx.answerCbQuery('Заказы очищены.')
	} catch (err) {
		console.error('Ошибка очистки заказов:', err)
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
		if (msg === translations[lang].catalog) {
			const webAppUrl = `${process.env.WEBAPP_URL}?lang=${lang}&chat_id=${
				ctx.from.id
			}&phone=${ctx.session.contact || ''}`
			await ctx.reply(
				translations[lang].open_catalog,
				Markup.inlineKeyboard([
					[Markup.button.webApp(translations[lang].open_catalog, webAppUrl)],
				])
			)
		} else if (msg === translations[lang].cart) {
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
					await ctx.reply(translations[lang].cart_empty)
				}
			} catch (err) {
				console.error('Ошибка получения корзины:', err)
				await ctx.reply(translations[lang].cart_empty)
			}
		} else if (msg === translations[lang].orders) {
			const query = `SELECT * FROM orders WHERE chat_id = $1`
			try {
				const result = await pool.query(query, [ctx.from.id])
				const rows = result.rows
				if (rows.length > 0) {
					let txt =
						lang === 'ru'
							? '📦 <b>Ваши заказы:</b>\n\n'
							: '📦 <b>Mening buyurtmalarim:</b>\n\n'
					rows.forEach(ord => {
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
						txt += `✅ <b>Заказ №${ord.merchant_trans_id}</b>\n💰 Сумма: ${ord.totalamount} UZS\n📌 Статус: ${statusText}\n🛍️ Товары:\n`
						const cartItems = ord.cart
						cartItems.forEach((item, idx) => {
							txt += `   ${idx + 1}. ${item.name} x ${item.quantity} шт. - ${
								item.price * item.quantity
							} UZS\n`
						})
						txt += `\n-----------------------\n`
					})
					const messages = txt.match(/[\s\S]{1,4000}/g)
					messages.forEach(async m => await ctx.replyWithHTML(m))
				} else {
					ctx.reply(translations[lang].order_empty)
				}
			} catch (err) {
				console.error('Ошибка получения заказов из БД:', err)
				ctx.reply('Ошибка получения заказов.')
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
		const query = `
      INSERT INTO users (chat_id, name, phone, language, last_activity)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (chat_id)
      DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, language = EXCLUDED.language, last_activity = CURRENT_TIMESTAMP
    `
		try {
			await pool.query(query, [
				ctx.from.id,
				ctx.session.name,
				contact.phone_number,
				ctx.session.language || 'ru',
			])
		} catch (err) {
			console.error('Ошибка сохранения пользователя в БД:', err)
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
			await ctx.reply(translations[lang].invalid_data)
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

// ***********************
// CLICK-интеграция: создание заказа через WooCommerce
// ***********************
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
		const insertQuery = `
      INSERT INTO orders (merchant_trans_id, chat_id, totalAmount, status, lang, cart, wc_order_id, wc_order_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `
		try {
			await pool.query(insertQuery, [
				merchant_trans_id,
				chat_id,
				totalAmount,
				'CREATED',
				lang || 'ru',
				JSON.stringify(cart),
				order_id,
				order_key,
			])
			const txt = translations[lang || 'ru'].order_created
				.replace('{{merchant_trans_id}}', merchant_trans_id)
				.replace('{{amount}}', totalAmount)
				.replace('{{url}}', payUrl)
			bot.telegram
				.sendMessage(chat_id, txt)
				.catch(e => console.error('Ошибка Telegram (Click):', e))
			return res.json({ success: true, clickLink: payUrl })
		} catch (err) {
			console.error('Ошибка сохранения заказа в БД:', err)
			return res.status(500).json({
				success: false,
				error: 'Ошибка при создании заказа WooCommerce',
			})
		}
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

// ***********************
// Payme-интеграция: создание заказа через WooCommerce
// ***********************
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
		const insertQuery = `
      INSERT INTO orders (merchant_trans_id, chat_id, totalAmount, status, lang, cart, wc_order_id, wc_order_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `
		try {
			await pool.query(insertQuery, [
				merchant_trans_id,
				chat_id,
				totalAmount,
				'CREATED',
				lang || 'ru',
				JSON.stringify(cart),
				order_id,
				order_key,
			])
			const textMsg = `Заказ №${merchant_trans_id}\nСумма: ${wcTotal} UZS\nОплатить:\n${payUrl}`
			bot.telegram
				.sendMessage(chat_id, textMsg)
				.catch(e =>
					console.error('Ошибка Telegram при отправке Payme ссылки:', e)
				)
			return res.json({ success: true, paymeLink: payUrl })
		} catch (err) {
			console.error('Ошибка сохранения заказа Payme в БД:', err)
			return res.status(500).json({
				success: false,
				error: 'Ошибка при создании заказа WooCommerce',
			})
		}
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

// ***********************
// Эндпоинты для работы с корзиной и заказами
// ***********************
app.post('/save-cart', async (req, res) => {
	const { chat_id, cart } = req.body
	if (!chat_id || !cart) {
		return res
			.status(400)
			.json({ success: false, error: 'Некорректные данные' })
	}
	const cartJSON = JSON.stringify(cart)
	const query = `INSERT INTO carts (chat_id, cart)
                 VALUES ($1, $2)
                 ON CONFLICT (chat_id) DO UPDATE SET cart = EXCLUDED.cart`
	try {
		await pool.query(query, [chat_id, cartJSON])
		return res.json({ success: true })
	} catch (err) {
		console.error('Ошибка сохранения корзины в БД:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

app.get('/get-car', async (req, res) => {
	const chat_id = req.query.chat_id
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const query = `SELECT cart FROM carts WHERE chat_id = $1`
	try {
		const result = await pool.query(query, [chat_id])
		if (result.rows.length) {
			const row = result.rows[0]
			return res.json({ success: true, cart: row.cart })
		} else {
			return res.json({ success: true, cart: [] })
		}
	} catch (err) {
		console.error('Ошибка получения корзины из БД:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

app.get('/get-orders', async (req, res) => {
	const chat_id = req.query.chat_id
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const query = `SELECT * FROM orders WHERE chat_id = $1`
	try {
		const result = await pool.query(query, [chat_id])
		const ordersWithStatus = result.rows.map(o => {
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
	} catch (err) {
		console.error('Ошибка получения заказов из БД:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

app.post('/clear-orders', async (req, res) => {
	const { chat_id } = req.body
	if (!chat_id) {
		return res.status(400).json({ success: false, error: 'chat_id не указан' })
	}
	const query = `DELETE FROM orders WHERE chat_id = $1`
	try {
		await pool.query(query, [chat_id])
		return res.json({ success: true, message: `Заказы очищены.` })
	} catch (err) {
		console.error('Ошибка очистки заказов:', err)
		return res.status(500).json({ success: false, error: 'Ошибка сервера' })
	}
})

// ***********************
// Self-ping (для предотвращения простоя, например, на Render.com)
// ***********************
if (process.env.RENDER_EXTERNAL_URL) {
	cron.schedule('*/10 * * * *', async () => {
		try {
			await axios.get(process.env.RENDER_EXTERNAL_URL)
			console.log('Self-ping: приложение активно.')
		} catch (error) {
			console.error('Self-ping: ошибка запроса:', error.message)
		}
	})
}

// ***********************
// Запуск сервера и бота
// ***********************
app.listen(PORT, () => {
	console.log(`🚀 Сервер запущен на порту ${PORT}`)
})

bot
	.launch()
	.then(() => console.log('Telegram-бот запущен'))
	.catch(err => console.error('Ошибка запуска Telegram-бота:', err))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
